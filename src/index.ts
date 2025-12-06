#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { Project, QuoteKind, VariableDeclarationKind } from "ts-morph";
import { jsonSchemaToZod } from "json-schema-to-zod";
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
  // Handle special characters, ensure valid TS identifier
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

function fixZodSchema(zodString: string): string {
  // Fix .default(null) on non-nullable types by inserting .nullable() before .default(null)
  // Handles cases with optional .describe() or other chained methods in between
  // e.g., .string().describe("...").default(null) -> .string().nullable().describe("...").default(null)
  return zodString.replace(
    /(\.(string|number|boolean|date|bigint|symbol)\(\))((?:\.[a-z]+\([^)]*\))*)\.default\(null\)/g,
    "$1.nullable()$3.default(null)"
  );
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

  // Ensure output directory exists
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
      console.log("inputSchema:", JSON.stringify(tool.inputSchema, null, 2));
      console.log("outputSchema:", tool.outputSchema ? JSON.stringify(tool.outputSchema, null, 2) : "(not defined)");
    });
    console.log("\n");
  }

  if (tools.length === 0) {
    console.warn("⚠️  No tools found");
    await client.close();
    process.exit(0);
  }

  // Prepare TypeScript project
  const project = new Project({
    useInMemoryFileSystem: false,
    manipulationSettings: { quoteKind: QuoteKind.Single },
  });

  const source = project.createSourceFile(outputFile, "", { overwrite: true });

  // Add imports
  source.addImportDeclaration({
    namedImports: ["z"],
    moduleSpecifier: "zod",
  });

  source.addStatements(""); // blank line

  // Generate individual schemas and types for each tool
  tools.forEach((tool) => {
    const { name, description, inputSchema } = tool;
    const schemaName = `${toPascalCase(toValidIdentifier(name))}Schema`;
    const typeName = `${toPascalCase(toValidIdentifier(name))}Params`;

    let zodSchemaString = "z.any()";
    try {
      zodSchemaString = fixZodSchema(jsonSchemaToZod(inputSchema).toString());
    } catch (err) {
      console.warn(`⚠️  Failed to convert schema for tool: ${name}`);
      console.warn(`   Using z.any() as fallback`);
    }

    // Add JSDoc comment
    source.addStatements(
      `/**\n * ${description || `Parameters for ${name}`}\n */`
    );

    // Export Zod schema
    source.addVariableStatement({
      declarationKind: VariableDeclarationKind.Const,
      isExported: true,
      declarations: [
        {
          name: schemaName,
          initializer: zodSchemaString,
        },
      ],
    });

    // Export inferred TypeScript type
    source.addTypeAlias({
      name: typeName,
      isExported: true,
      type: `z.infer<typeof ${schemaName}>`,
    });

    source.addStatements(""); // blank line

    // Generate output schema if present
    if (tool.outputSchema) {
      const outputSchemaName = `${toPascalCase(toValidIdentifier(name))}OutputSchema`;
      const outputTypeName = `${toPascalCase(toValidIdentifier(name))}Output`;

      let zodOutputString = "z.any()";
      try {
        zodOutputString = fixZodSchema(jsonSchemaToZod(tool.outputSchema).toString());
      } catch (err) {
        console.warn(`⚠️  Failed to convert output schema for tool: ${name}`);
        console.warn(`   Using z.any() as fallback`);
      }

      source.addStatements(`/**\n * Output for ${name}\n */`);

      source.addVariableStatement({
        declarationKind: VariableDeclarationKind.Const,
        isExported: true,
        declarations: [{ name: outputSchemaName, initializer: zodOutputString }],
      });

      source.addTypeAlias({
        name: outputTypeName,
        isExported: true,
        type: `z.infer<typeof ${outputSchemaName}>`,
      });

      source.addStatements(""); // blank line
    }
  });

  // Generate the main mcpTools object
  source.addVariableStatement({
    declarationKind: VariableDeclarationKind.Const,
    isExported: true,
    declarations: [
      {
        name: "mcpTools",
        initializer: (writer) => {
          writer.write("{\n");
          tools.forEach((tool, index) => {
            const { name, description } = tool;
            const schemaName = `${toPascalCase(toValidIdentifier(name))}Schema`;

            writer.write(`  /**\n   * ${description || name}\n   */\n`);
            writer.write(`  ${JSON.stringify(name)}: {\n`);
            writer.write(`    description: ${JSON.stringify(description)},\n`);
            writer.write(`    parameters: ${schemaName},\n`);
            if (tool.outputSchema) {
              const outputSchemaName = `${toPascalCase(toValidIdentifier(name))}OutputSchema`;
              writer.write(`    output: ${outputSchemaName},\n`);
            }
            writer.write(`  }${index < tools.length - 1 ? "," : ""}\n`);
          });
          writer.write("} as const");
        },
      },
    ],
  });

  source.addStatements(""); // blank line

  // Export union type of all tool names
  source.addTypeAlias({
    name: "ToolName",
    isExported: true,
    type: `keyof typeof mcpTools`,
  });

  // Format and write to disk
  await project.save();

  await client.close();

  console.log(`✅ Generated ${tools.length} MCP tools → ${outputFile}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
