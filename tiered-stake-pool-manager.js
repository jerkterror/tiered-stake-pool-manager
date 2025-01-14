const { Connection, PublicKey } = require('@solana/web3.js');
const { stakePoolInfo } = require('@solana/spl-stake-pool'); // Ensure this is installed
const cron = require('node-cron');
const { exec } = require('child_process');

let pendingStakeAdjustments = [];

// Tier Configuration
const tierConfig = {
  tiers: [
    { name: 'Tier 1', weight: 4 },
    { name: 'Tier 2', weight: 3 },
    { name: 'Tier 3', weight: 1 },
  ],
  validatorAssignments: [
    { pubkey: 'sTAchezFHQLXoJhyu6yJQ91MaxWrdiAx9fa2aPdGsKy', tier: 'Tier 1' },
    { pubkey: 'vots7XEfEXBoDiz7iPJvHRJedHAnRguEobUouj7BUG3', tier: 'Tier 2' },
    { pubkey: 'Gojir4F7uYGnpW8Zxr5wDyMPStyvHmRadFZxF18wKwP', tier: 'Tier 3' },
  ],
};

// Stake Pool Configuration
const myStakePoolConfig = {
  stakePoolAddress: 'FGHafnhSKbBEPqqZRjHM8xLLpUJxpnSbRigvvpJYSMPP', // Your stake pool address
  connection: new Connection('https://api.testnet.solana.com'), // Testnet RPC endpoint
  distributionAlgorithm: tieredDistributionAlgorithm,
  rebalanceIntervalEpochs: 10,
  stakeReservePublicKey: new PublicKey('F1fpc7zKXgwqe5Qcb38qpbGae8e1bmMKCGMxUTduJSng'), // Reserve stake address
  minimumReserve: 5000000000, // 5 SOL in lamports
};

// Fetch Stake Pool Balances with SDK
async function getStakePoolBalances(config) {
  const { stakePoolAddress, connection } = config;

  // Ensure stakePoolAddress is a PublicKey instance
  const stakePoolPubkey = new PublicKey(stakePoolAddress);

  console.log(`Fetching stake pool info for ${stakePoolPubkey.toString()}...`);

  try {
    const stakePoolDetails = await stakePoolInfo(connection, stakePoolPubkey);

    const validators = stakePoolDetails.validatorList.map((validator) => {
      return {
        pubkey: validator.voteAccountAddress,
        activeStake: parseInt(validator.activeStakeLamports, 10),
        transientStake: parseInt(validator.transientStakeLamports, 10),
        transientSeedSuffixStart: parseInt(validator.transientSeedSuffixStart, 10),
        transientSeedSuffixEnd: parseInt(validator.transientSeedSuffixEnd, 10),
        status: validator.status,
      };
    });

    return {
      totalLamports: parseInt(stakePoolDetails.totalLamports, 10),
      reserveLamports: stakePoolDetails.details.reserveStakeLamports,
      validators,
    };
  } catch (error) {
    console.error('Error fetching stake pool balances:', error);
    throw error;
  }
}

// Tiered Distribution Algorithm
function tieredDistributionAlgorithm(poolBalances) {
  const totalLamports = poolBalances.totalLamports;
  const tierWeights = tierConfig.tiers.reduce((sum, tier) => sum + tier.weight, 0);
  const tierAllocations = tierConfig.tiers.map((tier) => ({
    ...tier,
    allocation: Math.floor((tier.weight / tierWeights) * totalLamports),
  }));

  const validatorDistribution = [];
  for (const { name, allocation } of tierAllocations) {
    const tierValidators = tierConfig.validatorAssignments.filter((v) => v.tier === name);
    const stakePerValidator = Math.floor(allocation / tierValidators.length);

    tierValidators.forEach((validator) =>
      validatorDistribution.push({ validatorPubkey: validator.pubkey, stakeAmount: stakePerValidator })
    );
  }
  return validatorDistribution;
}

// Manage Stake Pool
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
    const validatorInfo = poolBalances.validators.find((v) => v.pubkey === validator.validatorPubkey);
    const currentTotalStake = (validatorInfo.activeStake || 0) + (validatorInfo.transientStake || 0);
    const difference = validator.stakeAmount - currentTotalStake;

    if (Math.abs(difference) < 100_000_000) {
      console.log(`Skipping adjustment for ${validator.validatorPubkey} as difference (${difference}) is below the threshold.`);
      continue;
    }

    if (difference > 0) {
      const success = await increaseStake(config, validator.validatorPubkey, difference);
      if (!success) {
        console.warn(`Partial increase for ${validator.validatorPubkey}. Will reattempt next epoch.`);
      }
    } else if (difference < 0) {
      await decreaseStake(config, validator.validatorPubkey, Math.abs(difference));
    }
  }

  console.log('Pending Stake Adjustments:', pendingStakeAdjustments);
}

// Increase Stake
async function increaseStake(config, validatorPubkey, amount) {
  const { stakeReservePublicKey, minimumReserve, connection } = config;

  const reserveBalance = (await connection.getAccountInfo(stakeReservePublicKey))?.lamports || 0;
  const maxAvailable = reserveBalance - minimumReserve;

  if (maxAvailable <= 0) {
    console.error(`Insufficient reserve balance: Available ${reserveBalance}, Minimum ${minimumReserve}`);
    return false;
  }

  const stakeAmountInSol = (amount / 1_000_000_000).toFixed(9);

  console.log(`Increasing stake for ${validatorPubkey} by ${stakeAmountInSol} SOL`);
  const cmd = `spl-stake-pool increase-validator-stake ${config.stakePoolAddress} ${validatorPubkey} ${stakeAmountInSol}`;
  return execCommand(cmd);
}

// Decrease Stake
async function decreaseStake(config, validatorPubkey, amount) {
  const stakeAmountInSol = (amount / 1_000_000_000).toFixed(9);

  console.log(`Decreasing stake for ${validatorPubkey} by ${stakeAmountInSol} SOL`);
  const cmd = `spl-stake-pool decrease-validator-stake ${config.stakePoolAddress} ${validatorPubkey} ${stakeAmountInSol}`;
  return execCommand(cmd);
}

// Utility to Execute CLI Commands
function execCommand(cmd) {
  return new Promise((resolve) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error executing command: ${stderr}`);
        resolve(false);
      } else {
        console.log(`Command output: ${stdout}`);
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
