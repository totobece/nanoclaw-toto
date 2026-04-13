---
name: notion-workspace
description: Full Notion workspace integration. Search, read, create, and update pages and databases. Use when the user mentions Notion, asks to save something to Notion, or wants to look up information from their workspace.
---

# Notion Workspace

You have full access to the user's Notion workspace via the `notion` MCP server.

## Available MCP Tools

- `notion_search` — search pages and databases by keyword
- `notion_fetch` — read full content of a page or database
- `notion_create_pages` — create new pages or database rows
- `notion_update_page` — update properties or content of an existing page

## Slash Commands

- `/Notion:search <query>` — search the workspace
- `/Notion:find <title terms>` — fuzzy find by title
- `/Notion:create-page <title> [parent]` — create a page
- `/Notion:create-task <title; due date; status>` — add a task
- `/Notion:database-query <database; filters>` — query a database

## Research & Documentation Workflow

1. `notion_search` to find relevant pages
2. `notion_fetch` to read full content
3. Synthesize across sources
4. `notion_create_pages` to write structured output with citations back to sources

## Spec to Implementation Workflow

1. Find spec via `notion_search`
2. Fetch with `notion_fetch`
3. Extract requirements → create implementation plan page
4. Find task database → create individual tasks
5. Track progress with `notion_update_page`

## Knowledge Capture

When the user asks to "save this to Notion" or "document this":
1. Classify content type (how-to, decision record, FAQ, meeting notes)
2. Identify destination (wiki, project page, database)
3. Create with clear title (searchable) and link to related pages — never orphaned content

## Meeting Intelligence

When preparing for a meeting:
1. Search Notion for relevant context
2. Create internal pre-read (comprehensive) + external agenda (professional)
3. Link documents bidirectionally

## Best Practices

- Never dump raw JSON — always return human-readable summaries with Notion links
- Cast wide net first, then filter
- Always link new pages back to related existing pages
- Check last-edited dates for currency of information
- For task databases: map title, status, due date, owner properties
