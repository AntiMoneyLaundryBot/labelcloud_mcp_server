# AMLBot Label Cloud MCP Server

An MCP (Model Context Protocol) server that provides AI assistants with tools to interact with the AMLBot Label Cloud API for blockchain address and entity management.

## Overview

This server exposes the AMLBot Label Cloud API as MCP tools, enabling AI assistants (like Claude) to:

- Add, search, and remove blockchain addresses from the label cloud
- Create, search, and manage entities (groups of related addresses)
- Associate addresses with entities
- Query supported blockchain networks and address types

## Architecture

The server uses a **hybrid OpenAPI-to-MCP approach**:

1. **OpenAPI Spec** (`docs/blacklist-api-endpoints.json`) - Source of truth for API schemas and parameters
2. **Tool Config** (`src/tool-config.ts`) - Maps API operations to MCP tools with custom names and descriptions; a `ToolConfig` can also carry `presetArgs` (fixed, hidden values merged into every call), `argAliases` (an exposed input renamed from its underlying OpenAPI param) and `omitArgs` (underlying params hidden from the schema entirely) - this lets several tools share one `operationId` with different, simplified input shapes (e.g. `get_auto_tracer_data` over the same `GET /addresses` operation as `search_addresses`)
3. **Parser** (`src/openapi-to-mcp.ts`) - Generates MCP tool definitions from OpenAPI spec at runtime, applying each config's presetArgs/argAliases/omitArgs

This architecture ensures:
- Single source of truth for API schemas
- Easy maintenance when API changes
- Control over which endpoints are exposed as tools
- Friendly tool names for AI assistants

`set_auto_tracing` is the **one exception**: it is hand-written in `src/set-auto-tracing.ts`,
not generated from the OpenAPI allow-list. It flips the `enableSniffer` flag on ONE address
by composing two allow-listed operations the server already exposes (`GET` then `POST
/addresses`) with a read-refuse-write sequence the declarative generator has no mechanism
for: it refuses if the address is absent or DELETED (never creates a row, never reactivates
a DELETED one), then re-posts the stored record with only the flag changed. No new backend
route exists for this - see the spec at
`ProductOwner/specs/4.inflight/SPEC-2026-09-18-labelcloud-mcp-auto-tracing-tools/spec.md`
(`## Amendments`, A3) for why.

## Available Tools

| Tool | Description |
|------|-------------|
| `create_address` | Add a blockchain address to the Label Cloud |
| `search_addresses` | Search for addresses in the Label Cloud |
| `set_auto_tracing` | Flip the LabelSniffer (auto-tracer / auto-label-propagation) flag on ONE existing address, without a full-record upsert |
| `get_auto_tracer_data` | Read the LabelSniffer flag and its five provenance fields for one address |
| `delete_address` | Remove an address from the Label Cloud |
| `get_entity_addresses` | Get all addresses associated with an entity |
| `get_addresses_by_origin` | Every address a red label propagated to from an origin address |
| `get_addresses_by_previous` | The direct children of one address in a propagation tree |
| `create_entity` | Create a new entity |
| `search_entities` | Search for entities |
| `get_entity` | Get an entity by ID |
| `delete_entity` | Delete an entity |
| `get_networks` | Get list of supported blockchain networks |
| `get_types` | Get list of available address/entity types |

## Installation

```bash
# Clone the repository
git clone <repository-url>
cd labelcloud-mcp-server

# Install dependencies
npm install

# Build the project
npm run build
```

## Configuration

Create a `.env` file based on `.env.example`:

```bash
cp .env.example .env
```

Edit `.env` with your API credentials:

```env
BLACKLIST_API_KEY=your_api_key_here
BLACKLIST_API_URL=https://api-blacklist.amlbot.com
```

## Usage

### Running the Server

```bash
npm start
```

The server communicates via stdio, making it compatible with MCP clients.

### Claude Desktop Integration

Add the server to your Claude Desktop configuration (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "labelcloud": {
      "command": "node",
      "args": ["/path/to/labelcloud-mcp-server/dist/index.js"],
      "env": {
        "BLACKLIST_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

### Development

```bash
# Watch mode for development
npm run dev

# Run tests
npm test
```

## Project Structure

```
labelcloud-mcp-server/
├── src/
│   ├── index.ts             # MCP server entry point
│   ├── tool-config.ts       # Tool definitions and mapping
│   ├── openapi-to-mcp.ts    # OpenAPI to MCP parser
│   └── set-auto-tracing.ts  # Hand-written set_auto_tracing composite (not generated)
├── docs/
│   └── blacklist-api-endpoints.json  # OpenAPI 3.0 spec
├── test/
│   ├── mcp-crud-address.test.ts    # Address CRUD tests
│   ├── mcp-crud-entity.test.ts     # Entity CRUD tests
│   ├── mcp-auto-tracing.test.ts    # set_auto_tracing / get_auto_tracer_data tests
│   └── mcp-metadata.test.ts        # Tool discovery & metadata tests
├── dist/                  # Compiled JavaScript
├── package.json
├── tsconfig.json
└── .env.example
```

## API Coverage

### Included Endpoints

The following API endpoints are exposed as MCP tools:

- `POST /v1/black-list/addresses` - Create address
- `GET /v1/black-list/addresses` - Search addresses
- `DELETE /v1/black-list/addresses/{address}` - Delete address
- `GET /v1/black-list/addresses/entity/{entityId}` - Get entity addresses
- `GET /v1/black-list/addresses/origin/{originAddress}` - Get addresses by origin
- `GET /v1/black-list/addresses/previous/{previousAddress}` - Get addresses by previous
- `POST /v1/black-list/entities` - Create entity
- `GET /v1/black-list/entities` - Search entities
- `GET /v1/black-list/entities/{entityId}` - Get entity
- `DELETE /v1/black-list/entities/{entityId}` - Delete entity
- `GET /v1/black-list/networks` - Get networks
- `GET /v1/black-list/types` - Get types

`set_auto_tracing` calls no new endpoint: it composes the existing `GET`/`POST
/v1/black-list/addresses` operations above (see Architecture).

### Excluded Endpoints

The following are intentionally excluded:

- **Account Management** - Admin operations (`/v1/accounts/*`)
- **File Operations** - File upload/management (not suitable for MCP)
- **Pagination** - Paginated endpoints (use standard search instead)
- **Legacy API** - Deprecated endpoints (`/api/addresses/*`)

## Testing

Run the test suite:

```bash
npm test
```

Or run individual test files:

```bash
# Tool discovery and metadata
node --import tsx --test test/mcp-metadata.test.ts

# Address CRUD operations
node --import tsx --test test/mcp-crud-address.test.ts

# Entity CRUD operations with address association
node --import tsx --test test/mcp-crud-entity.test.ts

# set_auto_tracing / get_auto_tracer_data round-trip
node --import tsx --test test/mcp-auto-tracing.test.ts
```

## Adding New Tools

To expose additional API endpoints as MCP tools:

1. Add the operation to `src/tool-config.ts`:

```typescript
{
  operationId: "ApiSomeController_operation",  // From OpenAPI spec
  name: "my_new_tool",                         // MCP tool name
  description: "Description for AI assistant", // Tool description
  include: true,                               // Set to true to enable
},
```

2. Rebuild the project:

```bash
npm run build
```

The tool will automatically pick up parameters and schemas from the OpenAPI spec.

## Supported Networks

The API supports 65+ blockchain networks including:

- Bitcoin, Ethereum, Tron, Solana
- Layer 2s: Arbitrum, Optimism, Base, Polygon, zkSync
- Other chains: Cosmos, Polkadot, Cardano, TON, and many more

Use the `get_networks` tool to retrieve the full list.

## Address Types

Addresses and entities can be categorized with types such as:

- `exchange` - Centralized exchanges
- `scam` - Scam addresses
- `mixer` - Mixing services
- `sanctions` - Sanctioned addresses
- `stolen_coins` - Theft-related addresses
- `other` - General category

Use the `get_types` tool to retrieve the full list with descriptions and severity levels.

## License

[Add your license here]

## Support

For issues with this MCP server, please open an issue in the repository.

For AMLBot API questions, contact AMLBot support.
