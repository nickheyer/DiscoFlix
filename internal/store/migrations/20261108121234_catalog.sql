-- Create "artworks" table
CREATE TABLE `artworks` (`id` text NOT NULL, `kind` text NOT NULL, `source` text NOT NULL, `source_url` text NOT NULL, `hash` text NOT NULL DEFAULT (''), `width` integer NOT NULL DEFAULT (0), `height` integer NOT NULL DEFAULT (0), `mime` text NOT NULL DEFAULT (''), `bytes` integer NOT NULL DEFAULT (0), `thumbhash` blob NULL, `variants` json NULL, `language` text NOT NULL DEFAULT (''), `score` real NOT NULL DEFAULT (0), `state` text NOT NULL DEFAULT ('pending'), `error` text NOT NULL DEFAULT (''), `created_at` datetime NOT NULL, `fetched_at` datetime NULL, `entity_id` text NOT NULL, PRIMARY KEY (`id`), CONSTRAINT `artworks_entities_artworks` FOREIGN KEY (`entity_id`) REFERENCES `entities` (`id`) ON DELETE NO ACTION);
-- Create index "artwork_entity_id_source_url" to table: "artworks"
CREATE UNIQUE INDEX `artwork_entity_id_source_url` ON `artworks` (`entity_id`, `source_url`);
-- Create index "artwork_entity_id_kind_score" to table: "artworks"
CREATE INDEX `artwork_entity_id_kind_score` ON `artworks` (`entity_id`, `kind`, `score`);
-- Create index "artwork_hash" to table: "artworks"
CREATE INDEX `artwork_hash` ON `artworks` (`hash`);
-- Create index "artwork_state" to table: "artworks"
CREATE INDEX `artwork_state` ON `artworks` (`state`);
-- Create "claims" table
CREATE TABLE `claims` (`id` text NOT NULL, `field` text NOT NULL, `value` blob NOT NULL, `value_hash` text NOT NULL, `source` text NOT NULL, `record_id` text NOT NULL DEFAULT (''), `user_id` text NOT NULL DEFAULT (''), `confidence` real NOT NULL DEFAULT (1), `rank` integer NOT NULL DEFAULT (100), `pinned` bool NOT NULL DEFAULT (false), `observed_at` datetime NOT NULL, `created_at` datetime NOT NULL, `entity_id` text NOT NULL, PRIMARY KEY (`id`), CONSTRAINT `claims_entities_claims` FOREIGN KEY (`entity_id`) REFERENCES `entities` (`id`) ON DELETE NO ACTION);
-- Create index "claim_entity_id_field_source_value_hash" to table: "claims"
CREATE UNIQUE INDEX `claim_entity_id_field_source_value_hash` ON `claims` (`entity_id`, `field`, `source`, `value_hash`);
-- Create index "claim_entity_id_field" to table: "claims"
CREATE INDEX `claim_entity_id_field` ON `claims` (`entity_id`, `field`);
-- Create index "claim_source_observed_at" to table: "claims"
CREATE INDEX `claim_source_observed_at` ON `claims` (`source`, `observed_at`);
-- Create "dataset_imports" table
CREATE TABLE `dataset_imports` (`id` text NOT NULL, `enabled` bool NOT NULL DEFAULT (false), `state` text NOT NULL DEFAULT ('idle'), `rows` integer NOT NULL DEFAULT (0), `bytes` integer NOT NULL DEFAULT (0), `error` text NOT NULL DEFAULT (''), `started_at` datetime NULL, `finished_at` datetime NULL, `etag` text NOT NULL DEFAULT (''), `last_modified` datetime NULL, `workflow_id` text NOT NULL DEFAULT (''), `updated_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Create "entities" table
CREATE TABLE `entities` (`id` text NOT NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, `kind` text NOT NULL, `title` text NOT NULL DEFAULT (''), `year` integer NOT NULL DEFAULT (0), `ordinal` integer NOT NULL DEFAULT (0), `merged_into_id` text NULL, `resolved_at` datetime NULL, `refreshed_at` datetime NULL, `parent_id` text NULL, PRIMARY KEY (`id`), CONSTRAINT `entities_entities_children` FOREIGN KEY (`parent_id`) REFERENCES `entities` (`id`) ON DELETE SET NULL);
-- Create index "entity_kind_title" to table: "entities"
CREATE INDEX `entity_kind_title` ON `entities` (`kind`, `title`);
-- Create index "entity_parent_id_ordinal" to table: "entities"
CREATE INDEX `entity_parent_id_ordinal` ON `entities` (`parent_id`, `ordinal`);
-- Create index "entity_merged_into_id" to table: "entities"
CREATE INDEX `entity_merged_into_id` ON `entities` (`merged_into_id`);
-- Create "entity_fields" table
CREATE TABLE `entity_fields` (`id` text NOT NULL, `field` text NOT NULL, `value` blob NOT NULL, `claim_id` text NOT NULL, `source` text NOT NULL, `reason` text NOT NULL, `agreement` integer NOT NULL DEFAULT (1), `claims` integer NOT NULL DEFAULT (1), `confidence` real NOT NULL DEFAULT (1), `observed_at` datetime NOT NULL, `resolved_at` datetime NOT NULL, `entity_id` text NOT NULL, PRIMARY KEY (`id`), CONSTRAINT `entity_fields_entities_fields` FOREIGN KEY (`entity_id`) REFERENCES `entities` (`id`) ON DELETE NO ACTION);
-- Create index "entityfield_entity_id_field" to table: "entity_fields"
CREATE UNIQUE INDEX `entityfield_entity_id_field` ON `entity_fields` (`entity_id`, `field`);
-- Create index "entityfield_field_source" to table: "entity_fields"
CREATE INDEX `entityfield_field_source` ON `entity_fields` (`field`, `source`);
-- Create "entity_titles" table
CREATE TABLE `entity_titles` (`id` integer NOT NULL PRIMARY KEY AUTOINCREMENT, `title` text NOT NULL, `normalized` text NOT NULL, `lang` text NOT NULL DEFAULT (''), `kind` text NOT NULL DEFAULT ('alias'), `source` text NOT NULL DEFAULT (''), `entity_id` text NOT NULL, CONSTRAINT `entity_titles_entities_titles` FOREIGN KEY (`entity_id`) REFERENCES `entities` (`id`) ON DELETE NO ACTION);
-- Create index "entitytitle_entity_id_normalized_lang" to table: "entity_titles"
CREATE UNIQUE INDEX `entitytitle_entity_id_normalized_lang` ON `entity_titles` (`entity_id`, `normalized`, `lang`);
-- Create index "entitytitle_normalized" to table: "entity_titles"
CREATE INDEX `entitytitle_normalized` ON `entity_titles` (`normalized`);
-- Create "ext_ids" table
CREATE TABLE `ext_ids` (`id` text NOT NULL, `namespace` text NOT NULL, `value` text NOT NULL, `p_match` real NOT NULL DEFAULT (1), `source` text NOT NULL DEFAULT (''), `created_at` datetime NOT NULL, `entity_id` text NOT NULL, PRIMARY KEY (`id`), CONSTRAINT `ext_ids_entities_ext_ids` FOREIGN KEY (`entity_id`) REFERENCES `entities` (`id`) ON DELETE NO ACTION);
-- Create index "extid_namespace_value" to table: "ext_ids"
CREATE UNIQUE INDEX `extid_namespace_value` ON `ext_ids` (`namespace`, `value`);
-- Create index "extid_entity_id" to table: "ext_ids"
CREATE INDEX `extid_entity_id` ON `ext_ids` (`entity_id`);
-- Create "im_db_akas" table
CREATE TABLE `im_db_akas` (`id` integer NOT NULL PRIMARY KEY AUTOINCREMENT, `tconst` text NOT NULL, `ordering` integer NOT NULL DEFAULT (0), `title` text NOT NULL DEFAULT (''), `normalized` text NOT NULL DEFAULT (''), `region` text NOT NULL DEFAULT (''), `language` text NOT NULL DEFAULT (''), `types` text NOT NULL DEFAULT (''), `original` bool NOT NULL DEFAULT (false));
-- Create index "imdbaka_tconst_ordering" to table: "im_db_akas"
CREATE UNIQUE INDEX `imdbaka_tconst_ordering` ON `im_db_akas` (`tconst`, `ordering`);
-- Create index "imdbaka_normalized" to table: "im_db_akas"
CREATE INDEX `imdbaka_normalized` ON `im_db_akas` (`normalized`);
-- Create "im_db_episodes" table
CREATE TABLE `im_db_episodes` (`id` text NOT NULL, `parent` text NOT NULL, `season` integer NOT NULL DEFAULT (0), `episode` integer NOT NULL DEFAULT (0), PRIMARY KEY (`id`));
-- Create index "imdbepisode_parent_season_episode" to table: "im_db_episodes"
CREATE INDEX `imdbepisode_parent_season_episode` ON `im_db_episodes` (`parent`, `season`, `episode`);
-- Create "im_db_ratings" table
CREATE TABLE `im_db_ratings` (`id` text NOT NULL, `rating` real NOT NULL DEFAULT (0), `votes` integer NOT NULL DEFAULT (0), PRIMARY KEY (`id`));
-- Create "im_db_titles" table
CREATE TABLE `im_db_titles` (`id` text NOT NULL, `title_type` text NOT NULL DEFAULT (''), `primary_title` text NOT NULL DEFAULT (''), `original_title` text NOT NULL DEFAULT (''), `normalized` text NOT NULL DEFAULT (''), `adult` bool NOT NULL DEFAULT (false), `start_year` integer NOT NULL DEFAULT (0), `end_year` integer NOT NULL DEFAULT (0), `runtime` integer NOT NULL DEFAULT (0), `genres` text NOT NULL DEFAULT (''), PRIMARY KEY (`id`));
-- Create index "imdbtitle_normalized_start_year" to table: "im_db_titles"
CREATE INDEX `imdbtitle_normalized_start_year` ON `im_db_titles` (`normalized`, `start_year`);
-- Create index "imdbtitle_title_type" to table: "im_db_titles"
CREATE INDEX `imdbtitle_title_type` ON `im_db_titles` (`title_type`);
-- Create "match_edges" table
CREATE TABLE `match_edges` (`id` text NOT NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, `entity_id` text NOT NULL, `namespace` text NOT NULL, `value` text NOT NULL, `source` text NOT NULL DEFAULT (''), `candidate_title` text NOT NULL DEFAULT (''), `candidate_year` integer NOT NULL DEFAULT (0), `probability` real NOT NULL DEFAULT (0), `features` json NULL, `tier` integer NOT NULL DEFAULT (1), `state` text NOT NULL DEFAULT ('auto'), `decided_by` text NOT NULL DEFAULT (''), `decided_at` datetime NULL, `message_seq` integer NOT NULL DEFAULT (0), PRIMARY KEY (`id`));
-- Create index "matchedge_entity_id" to table: "match_edges"
CREATE INDEX `matchedge_entity_id` ON `match_edges` (`entity_id`);
-- Create index "matchedge_namespace_value" to table: "match_edges"
CREATE INDEX `matchedge_namespace_value` ON `match_edges` (`namespace`, `value`);
-- Create index "matchedge_state_created_at" to table: "match_edges"
CREATE INDEX `matchedge_state_created_at` ON `match_edges` (`state`, `created_at`);
-- Create index "matchedge_message_seq" to table: "match_edges"
CREATE INDEX `matchedge_message_seq` ON `match_edges` (`message_seq`);
-- Create "match_models" table
CREATE TABLE `match_models` (`id` text NOT NULL, `weights` blob NOT NULL, `pairs` integer NOT NULL DEFAULT (0), `trained_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Create "source_records" table
CREATE TABLE `source_records` (`id` text NOT NULL, `source` text NOT NULL, `namespace` text NOT NULL DEFAULT (''), `ext_value` text NOT NULL DEFAULT (''), `kind` text NOT NULL DEFAULT (''), `url` text NOT NULL DEFAULT (''), `status` integer NOT NULL DEFAULT (0), `etag` text NOT NULL DEFAULT (''), `payload` blob NULL, `license` text NOT NULL DEFAULT (''), `fetched_at` datetime NOT NULL, `expires_at` datetime NULL, PRIMARY KEY (`id`));
-- Create index "sourcerecord_source_namespace_ext_value_fetched_at" to table: "source_records"
CREATE INDEX `sourcerecord_source_namespace_ext_value_fetched_at` ON `source_records` (`source`, `namespace`, `ext_value`, `fetched_at`);
-- Create index "sourcerecord_source_url_fetched_at" to table: "source_records"
CREATE INDEX `sourcerecord_source_url_fetched_at` ON `source_records` (`source`, `url`, `fetched_at`);
-- Create index "sourcerecord_fetched_at" to table: "source_records"
CREATE INDEX `sourcerecord_fetched_at` ON `source_records` (`fetched_at`);
-- Create "source_states" table
CREATE TABLE `source_states` (`id` text NOT NULL, `enabled` bool NOT NULL DEFAULT (true), `last_ok_at` datetime NULL, `last_error` text NOT NULL DEFAULT (''), `last_error_at` datetime NULL, `calls_today` integer NOT NULL DEFAULT (0), `calls_reset_at` datetime NOT NULL, `options` json NULL, `updated_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Create "tmdb_exports" table
CREATE TABLE `tmdb_exports` (`id` integer NOT NULL PRIMARY KEY AUTOINCREMENT, `kind` text NOT NULL, `tmdb_id` integer NOT NULL, `original_title` text NOT NULL DEFAULT (''), `normalized` text NOT NULL DEFAULT (''), `popularity` real NOT NULL DEFAULT (0), `adult` bool NOT NULL DEFAULT (false), `video` bool NOT NULL DEFAULT (false));
-- Create index "tmdbexport_kind_tmdb_id" to table: "tmdb_exports"
CREATE UNIQUE INDEX `tmdbexport_kind_tmdb_id` ON `tmdb_exports` (`kind`, `tmdb_id`);
-- Create index "tmdbexport_normalized" to table: "tmdb_exports"
CREATE INDEX `tmdbexport_normalized` ON `tmdb_exports` (`normalized`);
-- Create index "tmdbexport_kind_popularity" to table: "tmdb_exports"
CREATE INDEX `tmdbexport_kind_popularity` ON `tmdb_exports` (`kind`, `popularity`);
-- Create "entity_title_fts" trigram index over entity titles, kept in step by triggers
CREATE VIRTUAL TABLE `entity_title_fts` USING fts5(`title`, `normalized`, content='entity_titles', content_rowid='id', tokenize='trigram remove_diacritics 1');
-- Create trigger "entity_title_ai"
CREATE TRIGGER `entity_title_ai` AFTER INSERT ON `entity_titles` BEGIN INSERT INTO `entity_title_fts`(rowid, `title`, `normalized`) VALUES (new.`id`, new.`title`, new.`normalized`); END;
-- Create trigger "entity_title_ad"
CREATE TRIGGER `entity_title_ad` AFTER DELETE ON `entity_titles` BEGIN INSERT INTO `entity_title_fts`(`entity_title_fts`, rowid, `title`, `normalized`) VALUES ('delete', old.`id`, old.`title`, old.`normalized`); END;
-- Create trigger "entity_title_au"
CREATE TRIGGER `entity_title_au` AFTER UPDATE ON `entity_titles` BEGIN INSERT INTO `entity_title_fts`(`entity_title_fts`, rowid, `title`, `normalized`) VALUES ('delete', old.`id`, old.`title`, old.`normalized`); INSERT INTO `entity_title_fts`(rowid, `title`, `normalized`) VALUES (new.`id`, new.`title`, new.`normalized`); END;
-- Create "imdb_title_fts" standalone index over non-episode IMDb titles, filled by the dataset loader
CREATE VIRTUAL TABLE `imdb_title_fts` USING fts5(`tconst` UNINDEXED, `title`, tokenize='unicode61 remove_diacritics 2');
