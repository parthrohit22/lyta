# Lanternfish architecture (fictional demo)
- Gateway: sessions in KV, 30 min idle TTL.
- SyncService: GET /bookmarks, 100 per page.
- SearchIndexer: indexes bookmark titles.
- TrashService: purges deleted items after 7 days.

Invented for the LYTA drift demo; not a real design.
