# Open Source License Requirements

This project includes third-party open source software through npm and Cargo dependencies.

## Distribution Requirements

When distributing this project (internal, TestFlight, enterprise, or public):

1. Include a project license file at the repository root (`LICENSE`).
2. Preserve copyright and license notices from all third-party dependencies.
3. Provide a third-party notices document with shipped builds.
4. Keep dependency license metadata available for audit.

## Third-Party Notices

At minimum, generate and keep a `THIRD_PARTY_NOTICES` file for each release build that includes:

- package/crate name
- version
- license identifier
- attribution text when required by license

## Practical Policy

- Do not remove existing license headers from source files.
- Do not copy code/assets from external projects unless the license allows redistribution.
- If a dependency license is copyleft or has notice obligations, ensure notices are included before shipping.
- Re-run license checks whenever dependencies change.

## App Distribution Note

For mobile distributions, ensure the same third-party notices used for repository/release artifacts are also available for app review and legal compliance workflows.
