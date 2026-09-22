CREATE INDEX "publication_heads_expiry_idx" ON "publication_heads" ("expires_at", "public_slug" COLLATE "C");
