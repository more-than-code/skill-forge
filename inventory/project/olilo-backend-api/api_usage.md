# API Usage Documentation

Base URL: `/api/v1`

This API is built with FastAPI. It provides endpoints for accessing financial entity data, generating reports, and user authentication.

## Authentication

The application uses OIDC for authentication.

*   **Login**: Redirect the user to `/redirect/user/login`. This will start the OIDC flow.
*   **Logout**: Redirect the user to `/redirect/user/logout`.
*   **Session**: Authentication is stateful using a secure session cookie (`session_state`).

## Endpoints

### Entity Data

#### Search Entities
Search for entities by name, CIK, or alias.

*   **Endpoint**: `GET /api/v1/entities/search`
*   **Parameters**:
    *   `q` (query, optional, default: ""): Search term.
    *   `limit` (query, optional, default: 10): Max number of results (1-100).
*   **Response**: `List[Entity]`

#### List Available Quarters
Get a list of financial quarters for which data is available.

*   **Endpoint**: `GET /api/v1/quarters`
*   **Response**: `QuarterListResponse`

#### Entity Summary
Get high-level metrics for an entity in a specific quarter.

*   **Endpoint**: `GET /api/v1/entities/{cik}/summary`
*   **Parameters**:
    *   `cik` (path): Central Index Key identifier.
    *   `quarter` (query): Quarter string (e.g., "2025Q1").
*   **Response**: `EntitySummary`

#### Sector Allocation
Get sector-wise asset allocation.

*   **Endpoint**: `GET /api/v1/entities/{cik}/sector-allocation`
*   **Parameters**:
    *   `cik` (path): Central Index Key identifier.
    *   `quarter` (query): Quarter string.
    *   `top_n` (query, default: 11): Number of top sectors to return.
    *   `group_others` (query, default: true): Whether to group remaining sectors into "Others".
*   **Response**: `SectorAllocationResponse`

#### Asset Allocation
Get asset-wise allocation (top holdings).

*   **Endpoint**: `GET /api/v1/entities/{cik}/asset-allocation`
*   **Parameters**:
    *   `cik` (path): Central Index Key identifier.
    *   `quarter` (query): Quarter string.
    *   `top_n` (query, default: 15): Number of top assets to return.
    *   `group_others` (query, default: true): Whether to group remaining assets.
*   **Response**: `AssetAllocationResponse`

#### Get Holdings (Paginated)
Get a list of individual holdings.

*   **Endpoint**: `GET /api/v1/entities/{cik}/holdings`
*   **Parameters**:
    *   `cik` (path): Central Index Key identifier.
    *   `quarter` (query): Quarter string.
    *   `limit` (query, default: 100): Page size.
    *   `offset` (query, default: 0): Pagination offset.
*   **Response**: `HoldingsResponse`

#### Export Holdings
Download holdings as a CSV file.

*   **Endpoint**: `GET /api/v1/entities/{cik}/holdings/export`
*   **Parameters**:
    *   `cik` (path): Central Index Key identifier.
    *   `quarter` (query): Quarter string.
*   **Response**: `text/csv` attachment

### Reports

#### Generate Insight Report
Generate a comparative report between two entities or two quarters for the same entity.

*   **Endpoint**: `GET /api/v1/entities/insight-report`
*   **Parameters**:
    *   `cik_1` (query, required): Primary entity CIK.
    *   `cik_2` (query, optional): Secondary entity CIK.
    *   `quarter_1` (query, required): Primary quarter.
    *   `quarter_2` (query, optional): Secondary quarter.
*   **Response**: `InsightReportResponse`

### User

#### Get User Profile
Get the profile of the currently logged-in user.

*   **Endpoint**: `GET /api/v1/user/profile`
*   **Response**: `UserProfile`

## Data Models

### Entity
```json
{
  "cik": "string",
  "name": "string",
  "aliases": ["string"]
}
```

### QuarterListResponse
```json
{
  "quarters": ["string"]
}
```

### EntitySummary
```json
{
  "entity": { "cik": "...", "name": "..." },
  "quarter": "string",
  "aum_usd_thousands": 0,
  "positions_count": 0,
  "updated_at": "datetime"
}
```

### SectorAllocationResponse
```json
{
  "entity": { ... },
  "quarter": "string",
  "allocations": [
    {
      "sector": "string",
      "weight_pct": 0.0
    }
  ]
}
```

### AssetAllocationResponse
```json
{
  "entity": { ... },
  "quarter": "string",
  "allocations": [
    {
      "ticker": "string (nullable)",
      "weight_pct": 0.0
    }
  ]
}
```

### HoldingsResponse
```json
{
  "entity": { ... },
  "quarter": "string",
  "items": [
    {
      "doc_key": "string",
      "cusip": "string",
      "fund_name": "string (nullable)",
      "ticker": "string (nullable)",
      "sector": "string (nullable)",
      "value": 0,
      "shares": 0,
      "weight_pct": 0.0
    }
  ],
  "next_offset": 0
}
```

### InsightReportResponse
```json
{
  "id": "string",
  "user_id": "string (nullable)",
  "title": "string",
  "summary": "string",
  "report_type": "string (single_cik_compare_quarters | compare_two_ciks_single_quarter)",
  "cik_1": "string",
  "cik_2": "string (nullable)",
  "quarter_1": "string",
  "quarter_2": "string (nullable)",
  "focal_keywords": ["string"],
  "entity_1_summaries": [ { "entity": ..., "aum_usd_thousands": ... } ],
  "entity_2_summaries": [ ... ],
  "entity_1_sector_allocations": [ ... ],
  "entity_2_sector_allocations": [ ... ],
  "entity_1_asset_allocations": [ ... ],
  "entity_2_asset_allocations": [ ... ],
  "holding_changes": [
    {
      "asset_name": "string",
      "change_type": "string (Added | Reduced | Opened | Closed)",
      "change_amount": 0.0
    }
  ],
  "holding_comparison": {
    "common_holdings": ["string"],
    "unique_to_cik_1": ["string"],
    "unique_to_cik_2": ["string"],
    "percentage_difference": 0.0
  },
  "is_public": true,
  "created_at": "string",
  "updated_at": "string"
}
```

### UserProfile
```json
{
  "name": "string",
  "email": "string",
  "phone_number": "string (nullable)"
}
```
