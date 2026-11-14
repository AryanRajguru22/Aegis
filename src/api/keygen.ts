import { generateRootKeyPair, privateKeyToHex } from "../capability/index.js";
import { generateLedgerKeyPair, ledgerPrivateKeyToHex } from "../state/index.js";

/** `npm run keygen` — prints a fresh root and ledger signing key as ready-to-paste env lines. Store them in your secret manager; never commit them. */
console.log(`AEGIS_ROOT_PRIVATE_KEY_HEX=${privateKeyToHex(generateRootKeyPair().privateKey)}`);
console.log(`AEGIS_LEDGER_PRIVATE_KEY_HEX=${ledgerPrivateKeyToHex(generateLedgerKeyPair().privateKey)}`);
