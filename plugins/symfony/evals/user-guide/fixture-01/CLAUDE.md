# Acme Notes

A hosted notes tool for teams, on Symfony 7.4. A customer gets a **workspace**.

This checkout has no `vendor/` directory, so `bin/console` does not run here: read the files.

## People

- **Member** (`ROLE_MEMBER`): writes notes.
- **Workspace admin** (`ROLE_ADMIN`): the customer's own administrator. Invites members.
- **Acme staff** (`ROLE_STAFF`): Acme's own support people. A customer's people never hold this
  role.

## Documentation

- `docs/admin-guide.md`: the guide a workspace admin reads inside the product.
- `docs/operations.md`: for Acme staff only.
- Ground every statement in the code.
