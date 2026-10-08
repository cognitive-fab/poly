# OpenSearch responses, recorded for the source adapter's tests

Each file is a response body in the shape the OpenSearch REST API documents, for an index `orders` whose documents hold `customer_id`, `updated_at` and `summary`, with two customers' orders seeded (K14):

- `search-customer-a.json`: `POST /orders/_search` with a `term` filter on `customer_id`, sorted by `updated_at` descending (Search API, "Response body fields").
- `doc-order-1002.json` and `doc-missing.json`: `GET /orders/_doc/<id>`, found and not found (Get document API).
- `delete-by-query-customer-a.json`: `POST /orders/_delete_by_query?refresh=true` (Delete by query API).

The values are the tests' own; no live cluster was called. A cluster whose responses differ from the documentation is not covered (K14, the plan's third risk).
