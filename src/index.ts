#!/usr/bin/env ts-node

import fs from "node:fs";
import path from "node:path";
import { Project, QuoteKind, VariableDeclarationKind } from "ts-morph";
import { jsonSchemaToZod } from "json-schema-to-zod";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

/** ---- CONFIG ---- */
const OUTPUT_FILE = path.resolve("generated/mcp-tools.ts");
const SERVER_COMMAND = "mcp-server";
const SERVER_ARGS: string[] = [];

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

async function main() {
  console.log("🔌 Starting MCP Codegen…");

  // Ensure output directory exists
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });

  const transport = new StdioClientTransport({
    command: SERVER_COMMAND,
    args: SERVER_ARGS,
  });

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

  const source = project.createSourceFile(OUTPUT_FILE, "", { overwrite: true });

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
      zodSchemaString = jsonSchemaToZod(inputSchema).toString();
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

  console.log(`✅ Generated ${tools.length} MCP tools → ${OUTPUT_FILE}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
