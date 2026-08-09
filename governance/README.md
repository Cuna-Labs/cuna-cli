# Product governance

This directory contains executable gates that keep the accepted PRD baseline
connected to delivery evidence.

Run the structural PRD gate with:

```sh
node governance/validate-prd-dag.mjs
```

The gate rejects missing catalog nodes, dependency cycles, duplicate identities,
unaccepted specifications, unresolved placeholders, and requirement documents
without stable test identities. It deliberately does not claim that referenced
tests pass; implementation coverage and runtime evidence are separate release
gates.
