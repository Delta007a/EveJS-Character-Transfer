# EveJS Private Identity Transfer r1.5 — 0.12.7 -> 0.12.7.1 classic migration

cd "G:\EVESP\EveJS-Private-Identity-Transfer-r1.5"

$Source = "G:\EVESP\EveJS-CodexLab\EveJS-0.12.7-test"
$Target = "G:\EVESP\EveJS-CodexLab\EveJS-0.12.7.1-test"
$RunDir = "G:\EVESP\EveJS-Private-Identity-Transfer-r1.5\runs\0.12.7-to-0.12.7.1"
$Bundle = "$RunDir\private-state-0.12.7-r1.5.json"
New-Item -ItemType Directory -Force $RunDir | Out-Null

node --check .\private-identity-transfer.js
node .\verify-private-identity-transfer-static.js
node .\verify-private-identity-transfer-structure-policy.js
node .\verify-private-identity-transfer-wallet.js
node .\verify-private-identity-transfer-portraits.js

node .\private-identity-transfer.js export --source-root $Source --out $Bundle
node .\private-identity-transfer.js inspect --in $Bundle

node .\private-identity-transfer.js import --target-root $Target --in $Bundle --replace-existing
# After reviewing dry-run:
# node .\private-identity-transfer.js import --target-root $Target --in $Bundle --replace-existing --apply

node .\private-identity-transfer.js portraits --source-root $Source --target-root $Target --in $Bundle
# After reviewing portrait dry-run:
# node .\private-identity-transfer.js portraits --source-root $Source --target-root $Target --in $Bundle --apply
