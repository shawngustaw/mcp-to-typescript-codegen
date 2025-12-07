#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { Project, VariableDeclarationKind } from "ts-morph";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

// ─────────────────────────────────────────────────────────────────────────────
// CLI Setup
// ─────────────────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    command: { type: "string", short: "c" },
    args: { type: "string", short: "a" },
    server: { type: "string", short: "s" },
    output: { type: "string", short: "o" },
    name: { type: "string", short: "n" },
    help: { type: "boolean", short: "h" },
    debug: { type: "boolean", short: "d" },
  },
});

function printHelp() {
  console.log(`
mcp-to-typescript-codegen - Generate TypeScript types from MCP servers

Usage:
  mcp-to-typescript-codegen --command <cmd> [--args <args>] [--output <file>]
  mcp-to-typescript-codegen --server <url> [--output <file>]

Options:
  -c, --command <cmd>   Command to spawn MCP server (stdio transport)
  -a, --args <args>     Comma-separated args for the command
  -s, --server <url>    URL of HTTP MCP server (streamable HTTP transport)
  -o, --output <file>   Output file path (default: generated/mcp-tools.ts)
  -n, --name <prefix>   Prefix for generated type names (e.g., "Apollo")
  -d, --debug           Print raw tool schemas from server
  -h, --help            Show this help message

Examples:
  mcp-to-typescript-codegen --command "mcp-server"
  mcp-to-typescript-codegen --command "node" --args "./server.js,--port,3000"
  mcp-to-typescript-codegen --server "http://localhost:3000/mcp"
`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Transport Factory
// ─────────────────────────────────────────────────────────────────────────────

function createTransport(): Transport {
  if (values.server) {
    return new StreamableHTTPClientTransport(new URL(values.server));
  }

  if (values.command) {
    return new StdioClientTransport({
      command: values.command,
      args: values.args?.split(",") ?? [],
    });
  }

  throw new Error("Must specify either --command or --server");
}

// ─────────────────────────────────────────────────────────────────────────────
// String Helpers
// ─────────────────────────────────────────────────────────────────────────────

function toPascalCase(str: string): string {
  return str
    .split(/[-_\s]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

function toCamelCase(str: string): string {
  const pascal = toPascalCase(str);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

function toValidIdentifier(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON Schema to TypeScript
// ─────────────────────────────────────────────────────────────────────────────

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  description?: string;
  enum?: unknown[];
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  $ref?: string;
  default?: unknown;
  additionalProperties?: boolean | JsonSchema;
};

function jsonSchemaToTS(schema: JsonSchema): string {
  if (!schema || typeof schema !== "object") {
    return "unknown";
  }

  // Enum → union of literals
  if (schema.enum) {
    return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  }

  // oneOf/anyOf → union
  if (schema.oneOf || schema.anyOf) {
    const variants = schema.oneOf || schema.anyOf || [];
    return variants.map((v) => jsonSchemaToTS(v)).join(" | ");
  }

  // allOf → intersection
  if (schema.allOf) {
    return schema.allOf.map((v) => jsonSchemaToTS(v)).join(" & ");
  }

  // By type
  switch (schema.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return schema.items ? `(${jsonSchemaToTS(schema.items)})[]` : "unknown[]";
    case "object":
    default:
      return objectSchemaToTS(schema);
  }
}

function objectSchemaToTS(schema: JsonSchema): string {
  // No properties → empty object or Record type
  if (!schema.properties || Object.keys(schema.properties).length === 0) {
    if (schema.additionalProperties === true) {
      return "Record<string, unknown>";
    }
    if (typeof schema.additionalProperties === "object") {
      return `Record<string, ${jsonSchemaToTS(schema.additionalProperties)}>`;
    }
    return "{}";
  }

  // Build object type
  const required = new Set(schema.required || []);
  const props = Object.entries(schema.properties).map(([key, prop]) => {
    const opt = required.has(key) ? "" : "?";
    return `${key}${opt}: ${jsonSchemaToTS(prop)}`;
  });

  return `{ ${props.join("; ")} }`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  if (values.help) {
    printHelp();
    process.exit(0);
  }

  if (!values.command && !values.server) {
    console.error("Error: Must specify either --command or --server\n");
    printHelp();
    process.exit(1);
  }

  const outputFile = path.resolve(values.output ?? "generated/mcp-tools.ts");
  const prefix = values.name ? toPascalCase(values.name) : "";
  const prefixCamel = values.name ? toCamelCase(values.name) : "";

  console.log("🔌 Starting MCP Codegen…");

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });

  // Connect to MCP server
  const transport = createTransport();
  const client = new Client(
    { name: "mcp-codegen", version: "1.0.0" },
    { capabilities: {} }
  );
  await client.connect(transport);

  // Fetch tools
  console.log("🔍 Introspecting MCP tools…");
  const { tools } = await client.listTools();

  if (values.debug) {
    console.log("\n📋 Raw tool schemas from server:");
    for (const tool of tools) {
      console.log(`\n--- ${tool.name} ---`);
      console.log("inputSchema:", JSON.stringify(tool.inputSchema, null, 2));
      console.log(
        "outputSchema:",
        tool.outputSchema
          ? JSON.stringify(tool.outputSchema, null, 2)
          : "(not defined)"
      );
    }
    console.log("\n");
  }

  if (tools.length === 0) {
    console.warn("⚠️  No tools found");
    await client.close();
    process.exit(0);
  }

  // Create ts-morph project
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile(outputFile, "", {
    overwrite: true,
  });

  // Add header comment
  sourceFile.addStatements([
    "// Auto-generated by mcp-to-typescript-codegen",
    "// Do not edit manually",
    "",
  ]);

  // Generate types for each tool
  for (const tool of tools) {
    const toolId = toPascalCase(toValidIdentifier(tool.name));

    // Input params type
    sourceFile.addTypeAlias({
      name: `${prefix}${toolId}Params`,
      isExported: true,
      type: jsonSchemaToTS(tool.inputSchema as JsonSchema),
    });

    // Output type (if defined)
    if (tool.outputSchema) {
      sourceFile.addTypeAlias({
        name: `${prefix}${toolId}Output`,
        isExported: true,
        type: jsonSchemaToTS(tool.outputSchema as JsonSchema),
      });
    }
  }

  // Tool name union type
  sourceFile.addTypeAlias({
    name: `${prefix}ToolName`,
    isExported: true,
    type: tools.map((t) => `"${t.name}"`).join(" | "),
  });

  // Tool names array
  sourceFile.addVariableStatement({
    declarationKind: VariableDeclarationKind.Const,
    isExported: true,
    declarations: [
      {
        name: `${prefixCamel}toolNames`,
        initializer: `[${tools.map((t) => `"${t.name}"`).join(", ")}] as const`,
      },
    ],
  });

  // Write output
  const output = sourceFile.getFullText();
  fs.writeFileSync(outputFile, output);

  await client.close();
  console.log(`✅ Generated ${tools.length} MCP tools → ${outputFile}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
