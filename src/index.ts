#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

const { values } = parseArgs({
  options: {
    command: { type: "string", short: "c" },
    args: { type: "string", short: "a" },
    server: { type: "string", short: "s" },
    output: { type: "string", short: "o" },
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
  -d, --debug           Print raw tool schemas from server
  -h, --help            Show this help message

Examples:
  mcp-to-typescript-codegen --command "mcp-server"
  mcp-to-typescript-codegen --command "node" --args "./server.js,--port,3000"
  mcp-to-typescript-codegen --server "http://localhost:3000/mcp"
`);
}

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

function toPascalCase(str: string): string {
  return str
    .split(/[-_\s]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

function toValidIdentifier(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

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

function jsonSchemaToTS(schema: JsonSchema, indent = 0): string {
  const spaces = "  ".repeat(indent);

  if (!schema || typeof schema !== "object") {
    return "unknown";
  }

  // Handle enum
  if (schema.enum) {
    return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  }

  // Handle oneOf/anyOf
  if (schema.oneOf || schema.anyOf) {
    const variants = schema.oneOf || schema.anyOf || [];
    return variants.map((v) => jsonSchemaToTS(v, indent)).join(" | ");
  }

  // Handle allOf (intersection)
  if (schema.allOf) {
    return schema.allOf.map((v) => jsonSchemaToTS(v, indent)).join(" & ");
  }

  // Handle by type
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
      if (schema.items) {
        return `${jsonSchemaToTS(schema.items, indent)}[]`;
      }
      return "unknown[]";
    case "object":
      if (!schema.properties || Object.keys(schema.properties).length === 0) {
        if (schema.additionalProperties === true) {
          return "Record<string, unknown>";
        }
        if (
          schema.additionalProperties &&
          typeof schema.additionalProperties === "object"
        ) {
          return `Record<string, ${jsonSchemaToTS(schema.additionalProperties, indent)}>`;
        }
        return "Record<string, unknown>";
      }

      const required = new Set(schema.required || []);
      const props = Object.entries(schema.properties).map(([key, prop]) => {
        const optional = required.has(key) ? "" : "?";
        const comment = prop.description
          ? `${spaces}  /** ${prop.description} */\n`
          : "";
        return `${comment}${spaces}  ${key}${optional}: ${jsonSchemaToTS(prop, indent + 1)};`;
      });

      return `{\n${props.join("\n")}\n${spaces}}`;
    default:
      // No type specified, check for properties
      if (schema.properties) {
        const required = new Set(schema.required || []);
        const props = Object.entries(schema.properties).map(([key, prop]) => {
          const optional = required.has(key) ? "" : "?";
          const comment = prop.description
            ? `${spaces}  /** ${prop.description} */\n`
            : "";
          return `${comment}${spaces}  ${key}${optional}: ${jsonSchemaToTS(prop, indent + 1)};`;
        });
        return `{\n${props.join("\n")}\n${spaces}}`;
      }
      return "unknown";
  }
}

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

  console.log("🔌 Starting MCP Codegen…");

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });

  const transport = createTransport();

  const client = new Client(
    {
      name: "mcp-codegen",
      version: "1.0.0",
    },
    { capabilities: {} }
  );

  await client.connect(transport);

  console.log("🔍 Introspecting MCP tools…");
  const { tools } = await client.listTools();

  if (values.debug) {
    console.log("\n📋 Raw tool schemas from server:");
    tools.forEach((tool) => {
      console.log(`\n--- ${tool.name} ---`);
      console.log(
        "inputSchema:",
        JSON.stringify(tool.inputSchema, null, 2)
      );
      console.log(
        "outputSchema:",
        tool.outputSchema
          ? JSON.stringify(tool.outputSchema, null, 2)
          : "(not defined)"
      );
    });
    console.log("\n");
  }

  if (tools.length === 0) {
    console.warn("⚠️  No tools found");
    await client.close();
    process.exit(0);
  }

  // Generate TypeScript declarations
  const lines: string[] = [
    "// Auto-generated by mcp-to-typescript-codegen",
    "// Do not edit manually",
    "",
  ];

  tools.forEach((tool) => {
    const { name, inputSchema } = tool;
    const typeName = `${toPascalCase(toValidIdentifier(name))}Params`;

    // Generate input type
    const tsType = jsonSchemaToTS(inputSchema as JsonSchema);
    lines.push(`export type ${typeName} = ${tsType};`);
    lines.push("");

    // Generate output type if present
    if (tool.outputSchema) {
      const outputTypeName = `${toPascalCase(toValidIdentifier(name))}Output`;
      const outputTsType = jsonSchemaToTS(tool.outputSchema as JsonSchema);
      lines.push(`export type ${outputTypeName} = ${outputTsType};`);
      lines.push("");
    }
  });

  // Generate tool names union
  lines.push(
    `export type ToolName = ${tools.map((t) => JSON.stringify(t.name)).join(" | ")};`
  );
  lines.push("");

  // Generate tool names array
  lines.push("export const toolNames = [");
  tools.forEach((tool, index) => {
    const comma = index < tools.length - 1 ? "," : "";
    lines.push(`  ${JSON.stringify(tool.name)}${comma}`);
  });
  lines.push("] as const;");

  // Write file
  fs.writeFileSync(outputFile, lines.join("\n") + "\n");

  await client.close();

  console.log(`✅ Generated ${tools.length} MCP tools → ${outputFile}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
