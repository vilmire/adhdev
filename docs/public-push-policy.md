# Publish destination policy

A publish request uses a named Git remote. Approval identity comes from every
**effective push URL**, after Git applies URL rewrites. Canonical GitHub HTTPS
and SSH URLs resolve to `github.com/<owner>/<repository>` in lowercase. Local
paths, noncanonical hosts, ambiguous paths, query strings and other transports
are refused. Existing built-in approval keys (`root`, `oss`,
`adhdev-providers`, `homebrew-adhdev`) remain compatible.

Additional repositories require an explicit visibility entry in the committed
`.adhdev/public-push-patterns.json` at the authenticated private root:

```json
{
  "ownerNames": ["synthetic-owner"],
  "knownHosts": ["SyntheticHostZ"],
  "blockedText": ["synthetic-private-token"],
  "repositories": {
    "github.com/example/widget": "public",
    "github.com/example/internal": "private"
  }
}
```

These are synthetic examples. Visibility is an administrator assertion that
must be verified before committing policy; it is never inferred from the owner,
checkout, remote flags, or an approval SHA. Unknown visibility refuses publication
with `publish_policy_unmapped`, even when approvals were supplied. Arbitrary
repositories use the canonical identity itself as their approval-map key.

The root must retain its canonical private origin and committed pattern policy.
For an external root, `ADHDEV_PRIVATE_ROOT` also requires
`ADHDEV_PUBLIC_PUSH_PATTERNS_SHA256` matching the committed policy blob. Working
copy edits cannot grant visibility. Built-in public repositories cannot be
made private through this configuration. Every configured and effective URL
must independently qualify as private to skip public policy; aliases and
public-to-private rewrites retain public policy.

Public publication still requires both committed patterns and exact pending-SHA
approval. Every destination is checked; approvals for one repository do not
approve another. A flat approval list is accepted only for one repository.
Identity and full-history path guards remain mandatory for public repositories.

Fast-forward push dry-run and execution share this preflight before reporting
`push_available`. They return `publish_destination_malformed`,
`publish_policy_unmapped`, `publish_approval_required`, or
`publish_preflight_failed` as structured refusal codes. Dry-run can perform
read-only remote evidence checks. Neither mode relaxes the fast-forward-only
rule or manufactures approval for a different commit. Execution publishes the
exact commit checked by preflight.
