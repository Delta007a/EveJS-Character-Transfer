# Blocker and remediation catalog

Every BLOCKER card contains What, Why, How to fix, affected raw IDs, and the persistent Scan Again control. There is no bypass.

Accepted source codes mapped: `CHARACTER_ACTIVE_SHIP_DEFERRED`, `CHARACTER_IN_PLAYER_STRUCTURE`, `CHARACTER_NON_STATIC_STATION`, `CORPORATION_HQ_NON_STATIC`, `NON_STATIC_CORP_OFFICE_SKIPPED`, and `EXTERNAL_ITEM_LOCATIONS`.

Accepted target codes mapped: `TARGET_CORP_OFFICE_STATION_MISSING`, `TARGET_CHARACTER_ACTIVE_SHIP_DEFERRED`, `TARGET_CHARACTER_IN_PLAYER_STRUCTURE`, `TARGET_CHARACTER_STATION_MISSING`, `TARGET_CORPORATION_HQ_STATION_MISSING`, `TARGET_CORP_WORLD_ITEM_PRESENT`, and `TARGET_EXTERNAL_ITEM_LOCATIONS`.

`EXTERNAL_ITEM_LOCATIONS` receives an additional read-only, proof-gated classification for Industry, market, contract, and mission settlement custody. Unproven cases retain raw item/type/owner/location IDs and generic static-NPC-station recovery guidance.

Known player structures and their rooted inventory are DEFERRED, not blockers. Active mission progress without proven item custody is WARNING. Missing portrait media and absent wallet authority rows are non-blocking information.
