-- Epic #854 phase 3 (#859): resumability marker for the channel/montage backfill
-- sweep (POST /admin/datasets/channel-montage-sweep). Set once per dataset after
-- the exemplar EEG probe runs, success or not, so a re-run skips already-checked
-- rows and `remaining` converges to 0 -- mirrors archive_checked_at (0036).
--
-- The sweep writes n_channels / electrode_system (migration 0054) directly, WITHOUT
-- bumping updated_at/metadata_updated_at, so a one-time backfill of every EEG dataset
-- doesn't make them all read "updated today" or jump the newest-first sort.

ALTER TABLE datasets ADD COLUMN channel_montage_checked_at TEXT;
