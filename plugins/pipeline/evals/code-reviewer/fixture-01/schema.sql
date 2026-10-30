CREATE TABLE discount_code (
    workspace_id INTEGER NOT NULL,
    code VARCHAR(12) NOT NULL,
    percent SMALLINT NOT NULL,
    uses_left INTEGER NOT NULL,
    expires_at TIMESTAMP NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (workspace_id, code)
);
