# Source / field-evidence review — r1.5 delta

r1.5 is intentionally narrow. The existing r1.2 structure-deferral and selective-transfer architecture is retained.

## Proven field finding

During real 0.12.7 -> 0.12.7.1 gameplay QA, the migrated CEO showed 100,000 ISK although the live 0.12.7 source showed ~35.6M ISK plus wallet journal history. Direct comparison also proved `characters.balance` remained 100,000 in both releases, so it is not the authoritative Wallet UI state for this path.

Targeted database audit exposed the actual character authority row:

```text
table: walletAuthorityState
key:   character:<characterID>
```

Observed row fields include:

```text
characterID
balance
aurBalance
plexBalance
balanceChange
walletJournal[]
```

r1.2 omitted this table from its selective allowlist, so a fresh target generated/defaulted wallet authority instead of receiving the source state.

## r1.5 correction

`walletAuthorityState` is now a SIMPLE_CHARACTER_TABLE entry keyed exactly by `character:<id>`.

Consequences:

- export includes only selected character authority rows;
- replacement cleanup removes stale target rows for the imported character IDs;
- generic row import restores the exact source object;
- bundle validation rejects wallet rows outside selected characters or with key/value characterID mismatch;
- post-import verification requires exact wallet-authority row equality before accepting the transaction.

Bundle version is bumped from 3 to 4 so an r1.2 bundle without wallet authority cannot be silently reused.

## Portrait media evidence

Real field QA also proved character portrait metadata/IDs can migrate while the JPEG files remain outside SQLite. Source media was found under:

```text
_local\gameStore\images\Character
```

with filenames such as:

```text
140000005_32.jpg
140000005_64.jpg
140000005_128.jpg
140000005_256.jpg
140000005_512.jpg
140000005_1024.jpg
```

The old Test01 and copied target file had identical SHA256, while the pre-transfer Test06 file at the same characterID had a different hash. The EVE client displayed the correct copied portrait; launcher presentation remained independently cacheable/stale.

r1.5 therefore adds a separate portrait-media command rather than embedding binary media into the JSON bundle.

## Unchanged boundaries

- player structures and complete rooted inventory domain remain deferred;
- unknown dynamic locations remain blocking;
- world/dungeon/scheduler/market/mission/etc. runtime remains excluded;
- IDs are preserved in classic fresh-target mode;
- optional structure transfer remains a later separate pass.

Status: Source/field evidence reviewed for the r1.5 delta; gameplay retest of corrected wallet migration still required.
