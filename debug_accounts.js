require("dotenv").config();
const { listAccounts } = require("./lib/coinbase");

async function main() {
  const accounts = await listAccounts();
  console.log(`Found ${accounts.length} accounts.\n`);
  for (const a of accounts) {
    console.log(JSON.stringify(a, null, 2));
  }
}

main().then(() => process.exit(0));
