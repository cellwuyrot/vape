# VAPELAB — equal manager permissions and team hierarchy

## What changes

- A manager receives the same operational CRM/admin sections as an administrator: storefront/catalog, SEO/indexing, analytics, mail, reservations, public content, legal pages, settings, imports and activity log.
- A manager can invite managers, employees and viewers. The creating account is recorded in `users.invited_by`.
- A manager can change the role and active state of accounts in their own subordinate branch, and remove those accounts from the team.
- A subordinate cannot change, disable or remove an ancestor or a peer from another branch. `superadmin` and system `admin` accounts remain protected.
- Removing an account is a soft delete: login is disabled, the account disappears from the team list, and CRM history is retained. Its direct reports are reassigned to the manager who removed it.
- The previously delivered color-variant files and migration 016 are included unchanged so this patch does not overwrite that feature. The new hierarchy migration is 017.

## Install

1. Create a full backup of the application and its database.
2. Extract this archive over `/var/www/vapelab/app` with overwrite enabled.
3. Run `npm run check` using the project's Node.js 22 runtime.
4. If checks pass, restart the `vapelab` PM2 process. The normal startup migration runner applies migration 017.

Do not replace `.env`, `data/`, `logs/`, or `node_modules/`.

## Database migration

- `016_store_reservation_variant.sql` is the same color-variant migration shipped earlier; it is included to keep the migration chain complete on installations where it was not yet extracted.
- `017_manager_team_hierarchy.sql` adds `users.deleted_at` and indexes. It does not rewrite existing accounts or their `invited_by` values.

## Verification

The isolated SQLite suite passes with 199 tests and the lint scan reports no findings. Tests cover manager access to admin routes, nested manager appointment, ancestor protection, removal of a subordinate, and reassignment of that subordinate's direct reports.
