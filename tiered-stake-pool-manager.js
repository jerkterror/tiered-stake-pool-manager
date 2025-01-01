const { Connection, PublicKey } = require('@solana/web3.js');
const cron = require('node-cron');
const { exec } = require('child_process');
const { StakePoolLayout, ValidatorListLayout } = require('@solana/spl-stake-pool');

let pendingStakeAdjustments = [];

// Tier Configuration
const tierConfig = {
  tiers: [
    { name: 'Tier 1', weight: 4 },
    { name: 'Tier 2', weight: 3 },
    { name: 'Tier 3', weight: 1 },
  ],
  validatorAssignments: [
    // StachNode
    { pubkey: 'sTAchezFHQLXoJhyu6yJQ91MaxWrdiAx9fa2aPdGsKy', tier: 'Tier 1' },
    // Radiants
    { pubkey: 'vots7XEfEXBoDiz7iPJvHRJedHAnRguEobUouj7BUG3', tier: 'Tier 2' },
    // Gojira
    { pubkey: 'Gojir4F7uYGnpW8Zxr5wDyMPStyvHmRadFZxF18wKwP', tier: 'Tier 3' },
  ],
};

// Stake Pool Configuration
const myStakePoolConfig = {
  stakePoolAddress: 'FGHafnhSKbBEPqqZRjHM8xLLpUJxpnSbRigvvpJYSMPP',
  connection: new Connection('https://api.testnet.solana.com'),
  distributionAlgorithm: tieredDistributionAlgorithm,
  rebalanceIntervalEpochs: 10,
  stakeReservePublicKey: new PublicKey('F1fpc7zKXgwqe5Qcb38qpbGae8e1bmMKCGMxUTduJSng'),
  minimumReserve: 5000000000, // 5 SOL in lamports
};

// Tiered Distribution Algorithm
function tieredDistributionAlgorithm(poolBalances) {
  const totalLamports = parseInt(poolBalances.totalLamports.toString(), 10);
  const tierWeights = tierConfig.tiers.reduce((sum, tier) => sum + tier.weight, 0);
  const tierAllocations = tierConfig.tiers.map(tier => ({
    ...tier,
    allocation: Math.floor((tier.weight / tierWeights) * totalLamports),
  }));

  const validatorDistribution = [];
  for (const { name, allocation } of tierAllocations) {
    const tierValidators = tierConfig.validatorAssignments.filter(v => v.tier === name);
    const stakePerValidator = Math.floor(allocation / tierValidators.length);

    tierValidators.forEach(validator =>
      validatorDistribution.push({ validatorPubkey: validator.pubkey, stakeAmount: stakePerValidator })
    );
  }
  return validatorDistribution;
}

// Fetch Activation State for Transient Stake
async function fetchTransientStakeActivation(connection, validator) {
  try {
    if (!validator.transientStakeAccount) {
      console.warn(`Validator ${validator.pubkey} has no transient stake account.`);
      return null;
    }

    // If transient stake is positive, assume it is activating
    if (validator.transientStake > 0) {
      console.log(`Assuming transient stake for ${validator.pubkey} is activating.`);
      return "activating";
    }

    // If transient stake is zero, mark as inactive
    return "inactive";
  } catch (error) {
    console.warn(`Could not fetch activation state for ${validator.pubkey}: ${error.message}`);
    return null;
  }
}



// Fetch Stake Pool Balances with Transient Stake Account Calculation
async function getStakePoolBalances(config) {
  const { stakePoolAddress, connection } = config;
  console.log('Fetching stake pool balances...');

  const stakePoolPubkey = new PublicKey(stakePoolAddress);

  try {
    const stakePoolAccountInfo = await connection.getAccountInfo(stakePoolPubkey);
    if (!stakePoolAccountInfo) {
      throw new Error(`Stake pool account ${stakePoolAddress} not found.`);
    }

    const stakePoolData = StakePoolLayout.decode(stakePoolAccountInfo.data);
    const totalLamports = stakePoolData.totalLamports;

    const validatorListPubkey = new PublicKey(stakePoolData.validatorList);
    const validatorListAccountInfo = await connection.getAccountInfo(validatorListPubkey);
    if (!validatorListAccountInfo) {
      throw new Error(`Validator list account ${stakePoolData.validatorList} not found.`);
    }

    const validatorListData = ValidatorListLayout.decode(validatorListAccountInfo.data);
    const programId = new PublicKey('SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy'); // Stake pool program ID

    const validators = await Promise.all(
      validatorListData.validators.map(async (validator) => {
        const voteAccountAddress = new PublicKey(validator.voteAccountAddress);

        // Calculate transient stake account
        const transientStakeAccount = PublicKey.createProgramAddressSync(
          [Buffer.from(voteAccountAddress.toBytes()), Buffer.from("transient")],
          programId
        ).toString();

        const activationState = await fetchTransientStakeActivation(connection, {
          transientStakeAccount,
          pubkey: voteAccountAddress.toString(),
        });

        return {
          pubkey: voteAccountAddress.toString(),
          activeStake: validator.activeStakeLamports.toNumber(),
          transientStake: validator.transientStakeLamports.toNumber(),
          transientStakeAccount,
          activationState,
        };
      })
    );

    return {
      totalLamports,
      validators,
    };
  } catch (error) {
    console.error('Error fetching stake pool balances:', error);
    throw error;
  }
}

// Manage Stake Pool

const MINIMUM_STAKE_ADJUSTMENT = 100_000_000; // 0.1 SOL in lamports

async function manageStakePool(config) {
  const { connection, distributionAlgorithm } = config;
  const epochInfo = await connection.getEpochInfo();
  const currentEpoch = epochInfo.epoch;

  console.log(`Current Epoch: ${currentEpoch}`);
  const poolBalances = await getStakePoolBalances(config);
  console.log('Updated Pool Balances:', poolBalances);

  const newDistribution = distributionAlgorithm(poolBalances);
  console.log('Calculated New Distribution:', newDistribution);

  for (const validator of newDistribution) {
    const validatorInfo = poolBalances.validators.find(v => v.pubkey === validator.validatorPubkey);
    if (!validatorInfo) {
      console.warn(`Validator ${validator.validatorPubkey} not found in current pool balances.`);
      continue;
    }

    const currentTotalStake = (validatorInfo.activeStake || 0) + (validatorInfo.transientStake || 0);
    const difference = validator.stakeAmount - currentTotalStake;

    // Ignore adjustments below the minimum threshold
    if (Math.abs(difference) < MINIMUM_STAKE_ADJUSTMENT) {
      console.log(
        `Skipping adjustment for ${validator.validatorPubkey} as difference (${difference}) is below the minimum threshold (${MINIMUM_STAKE_ADJUSTMENT} lamports).`
      );
      continue;
    }

    if (difference > 0) {
      // Proceed with stake increase
      const success = await increaseStake(
        config,
        validator.validatorPubkey,
        difference,
        validatorInfo.transientStake,
        validatorInfo.activationState
      );
      if (!success) {
        console.warn(
          `Stake increase partially completed for ${validator.validatorPubkey}. Remaining amount will be re-attempted in the next epoch.`
        );
      }
    } else if (difference < 0) {
      // Proceed with stake decrease
      await decreaseStake(
        config,
        validator.validatorPubkey,
        Math.abs(difference),
        validatorInfo.activationState
      );
    }
  }

  console.log('Pending Stake Adjustments:', pendingStakeAdjustments);
}


// Increase Stake Function
async function increaseStake(config, validatorPubkey, amount, transientStake, activationState) {
  const { stakeReservePublicKey, minimumReserve, connection } = config;

  // Re-check the current reserve balance
  const reserveBalance = (await connection.getAccountInfo(stakeReservePublicKey))?.lamports || 0;
  const maxAvailable = reserveBalance - minimumReserve;

  if (maxAvailable <= 0) {
    console.error(
      `Insufficient reserve balance to meet minimum reserve. Available: ${reserveBalance}, Minimum: ${minimumReserve}`
    );
    return false;
  }

  // Skip if the transient stake is activating
  if (activationState === 'activating') {
    console.warn(`Skipping stake increase for ${validatorPubkey} due to activating transient stake.`);
    return false;
  }

  const stakeAmount = Math.min(amount, maxAvailable);
  if (stakeAmount <= 0) {
    console.error(`No reserve funds available for staking.`);
    return false;
  }

  // Convert lamports to SOL
  const stakeAmountInSol = (stakeAmount / 1_000_000_000).toFixed(9);

  console.log(`Requesting stake increase: Validator ${validatorPubkey}, Requested (lamports): ${amount}, Max Available: ${maxAvailable}`);
  console.log(`Final Stake Amount (SOL): ${stakeAmountInSol}`);
  console.log(`Command to execute: spl-stake-pool increase-validator-stake ${config.stakePoolAddress} ${validatorPubkey} ${stakeAmountInSol}`);

  const cmd = `spl-stake-pool increase-validator-stake ${config.stakePoolAddress} ${validatorPubkey} ${stakeAmountInSol}`;
  return new Promise(resolve => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error increasing stake: ${stderr}`);
        const remainingAmount = amount - stakeAmount;
        if (remainingAmount > 0) {
          pendingStakeAdjustments.push({ validator: validatorPubkey, amount: remainingAmount });
        }
        resolve(false);
      } else {
        console.log(`Increase stake output: ${stdout}`);
        resolve(true);
      }
    });
  });
}

// Decrease Stake Function
async function decreaseStake(config, validatorPubkey, amount, activationState) {
  // Skip if the transient stake is deactivating
  if (activationState === 'deactivating') {
    console.warn(`Skipping stake decrease for ${validatorPubkey} due to deactivating transient stake.`);
    return false;
  }

  // Skip if transient stake is activating
  if (activationState === 'activating') {
    console.warn(`Skipping stake decrease for ${validatorPubkey} due to activating transient stake.`);
    return false;
  }

  // Convert lamports to SOL
  const stakeAmountInSol = (amount / 1_000_000_000).toFixed(9);

  console.log(`Attempting to decrease stake for validator ${validatorPubkey} by ${stakeAmountInSol} SOL`);

  const cmd = `spl-stake-pool decrease-validator-stake ${config.stakePoolAddress} ${validatorPubkey} ${stakeAmountInSol}`;
  return new Promise(resolve => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error decreasing stake: ${stderr}`);
        resolve(false);
      } else {
        console.log(`Decrease stake output: ${stdout}`);
        resolve(true);
      }
    });
  });
}


// Execution
(async () => {
  try {
    console.log('Starting Tiered Stake Pool Manager...');
    await manageStakePool(myStakePoolConfig);
  } catch (error) {
    console.error('Error:', error);
  }
})();
