# VAPELAB storefront + CRM — implementation notes

## Current scope

- `/` — VAPELAB public information storefront with brand logo, Hero wave, expandable category accordion, product cards, company information, retail/wholesale sections, news and contacts.
- `/crm` — shared entry point for visitors and employees. The public button is labelled «Войти».
- `/api/store/public` — read-only public catalog, categories, approved content pages, news and brand settings.
- `/api/store/admin` — protected catalog/content management.
- `/api/users` — team management for superadmin/admin/managers with inviter-based hierarchy.
- `/api/auth/request-code` and `/api/auth/verify-code` — e-mail one-time-code authentication.
- `migrations/007_vapelab_auth_seo.sql` — team fields, SEO fields and keyword targets.
- `templates/VAPELAB-products-template.xlsx` — import spreadsheet template.
- `data/vapelab/` — observed-only CSV/JSON datasets; this is not a complete source export.

The public storefront intentionally has no cart, payment, checkout, preorder or customer-data collection flow. Old offer/privacy pages have not been rewritten or approved by the project. No legal conclusion about distance selling or advertising is encoded by this build.

## First run

Requires Node.js 22+.

```bash
cp .env.example .env
# Set a unique SECRET_KEY. For real mail delivery configure SMTP_URL and MAIL_FROM.
npm start
```

Open `http://localhost:3000/` and `http://localhost:3000/crm`.
The primary administrator profile is seeded as `andycoulbot@gmail.com` with role `superadmin`. There is no password login. In local development without `SMTP_URL`, one-time codes are written to the server log under `notify.dev`. In production the application requires a mail transport.

## Authentication and roles

- `superadmin`: `andycoulbot@gmail.com`, created at application startup; full access.
- `admin`: administrator, may invite and manage employees, but cannot promote users to `superadmin`.
- `manager`: can work with the CRM and store catalog; cannot manage user accounts.
- `agent`: CRM employee.
- `viewer`: read-only CRM role.
- `visitor`: e-mail profile created through the public entry point with explicit personal-data consent; access is limited to `/api/auth/me` and `/api/auth/profile`.

New employee accounts are created only from CRM → «Команда» by an administrator. The invited employee signs in using a code sent to their assigned e-mail. The old password-based login endpoint returns HTTP 410 and is not an alternate sign-in route.

## E-mail transport

`MAIL_FROM` defaults to `info@vaplab.ru`. `SMTP_URL` supports:

- `smtp://user:password@mail.example.ru:587` — uses STARTTLS; credentials are never sent without TLS.
- `smtps://user:password@mail.example.ru:465` — implicit TLS.
- `https://provider.example/send` — optional HTTP webhook receiving JSON `{from,to,subject,text}`.

Percent-encode special characters in the SMTP username/password URL components. Use a mailbox/domain and provider account controlled by the owner. Never commit `.env` or credentials.

## Catalog management, SEO and XLSX

CRM → «Витрина» supports products, categories, news and information pages. New records default to draft. CRM → Products includes XLSX/CSV import with column mapping, preview and dry-run. The import template is in `templates/VAPELAB-products-template.xlsx`.

Product fields preserve source price and availability labels as strings. SEO validation checks H1 existence/duplicates, title/description presence and length, keyword targets and image ALT. Keyword targets store the frequency class, actual volume when known, search engine, region, source and check date. Frequency values are not fabricated by the application.

Image suggestions can be requested by product name through Yandex Search API. Configure `YANDEX_SEARCH_API_KEY` and `YANDEX_SEARCH_FOLDER_ID`. The account needs a service account role `search-api.webSearch.user` and API key scope `yc.search-api.execute` (see the [official Yandex instructions](https://aistudio.yandex.ru/ru/docs/search-api/operations/search-images)). Results require manual selection. The product editor stores the source page and ALT label; image rights and exact model match still need human verification.

## Brand assets and design

The supplied VAPELAB emblem is included as a transparent WebP/PNG. The header shows it in a circular white field; a dark-background favicon family is included in `public/assets/brand/`. Logo and favicon URLs can be changed through store settings. Typography is set to Unbounded headings and Inter body text via Google Fonts; if external fonts cannot load, the UI falls back to system sans-serif.

The Hero is an in-project adaptation of the Hero 58 visual direction, using an animated blue/cyan wave field rather than the original section's framework-specific package. Spotlight, expandable category accordion and scroll-reveal effects are implemented with native CSS/JavaScript to avoid adding a React dependency to the existing CRM.

## Explicitly deferred

The image blur/hide checkbox, 18+ image classification, age gate and related access restrictions are documented as a next-stage requirement only. They are intentionally not implemented in this build. Before those controls are designed, the owner and counsel should define classification, public display and access rules; a CSS blur alone would not protect original media URLs.

## Test status and limitations

Run:

```bash
npm run check
```

The suite covers API auth, role boundaries, storefront/catalog, product SEO fields, XLSX/CSV import, image-search configuration handling, asset delivery, database migrations and the existing CRM/storage subsystems. Real SMTP delivery and live Yandex image-search results require owner credentials and are not claimed as end-to-end verified until configured.

The source catalog is not fully exported: categories and example products remain a demonstrated subset until a complete owner-approved product export and images are supplied. Price, stock, variant details, media rights and legal content require source/owner verification before production publication.
