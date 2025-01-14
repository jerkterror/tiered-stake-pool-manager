const { Connection, PublicKey } = require('@solana/web3.js');
const { stakePoolInfo } = require('@solana/spl-stake-pool'); // Replace with the SDK function

async function testStakePoolInfo() {
  // Replace with your stake pool address
  const stakePoolAddress = new PublicKey('FGHafnhSKbBEPqqZRjHM8xLLpUJxpnSbRigvvpJYSMPP');
  const connection = new Connection('https://api.testnet.solana.com'); // Use your RPC endpoint

  try {
    console.log(`Fetching stake pool info for ${stakePoolAddress.toString()}...`);
    
    const stakePoolDetails = await stakePoolInfo(connection, stakePoolAddress);

    console.log('Stake Pool Info:', JSON.stringify(stakePoolDetails, null, 2));
  } catch (error) {
    console.error('Error fetching stake pool info:', error);
  }
}

testStakePoolInfo();
