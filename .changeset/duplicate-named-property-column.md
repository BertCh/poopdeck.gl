---
'@poopdeck.gl/core': patch
---

Decode layers whose source carries a property column named `id`

The writer keeps such a column in the PROPS batch beside the reserved `UInt64`
`id` in CORE. Arrow JS rebuilds a record batch's schema by field name, so the
two collapsed onto one slot and `decodeTile` threw "Table and inner RecordBatch
schemas must be equivalent" for every tile of the dataset. The merged batch now
keeps its exact schema, and both columns survive with their own types, in
`decodeTile`, in `toGeoArrowTable()` and across the worker hand-off.
