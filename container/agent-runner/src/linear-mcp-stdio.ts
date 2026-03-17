/**
 * Linear MCP Server (stdio)
 * Read-only access to Linear issues, projects, and teams.
 * Reads LINEAR_API_KEY from environment.
 */
import { LinearClient } from '@linear/sdk';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const apiKey = process.env.LINEAR_API_KEY;
if (!apiKey) {
  process.stderr.write('LINEAR_API_KEY not set\n');
  process.exit(1);
}

const linear = new LinearClient({ apiKey });

const server = new Server(
  { name: 'linear', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'linear_my_issues',
      description: 'Get issues assigned to me, optionally filtered by state',
      inputSchema: {
        type: 'object',
        properties: {
          state: {
            type: 'string',
            description: 'Filter by state name e.g. "In Progress", "Todo", "Done"',
          },
          limit: { type: 'number', description: 'Max results (default 20)' },
        },
      },
    },
    {
      name: 'linear_search_issues',
      description: 'Search issues by keyword across all accessible teams',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          limit: { type: 'number', description: 'Max results (default 20)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'linear_get_issue',
      description: 'Get full details of a specific issue by its identifier (e.g. ENG-123) or UUID',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Issue identifier like ENG-123 or UUID' },
        },
        required: ['id'],
      },
    },
    {
      name: 'linear_list_teams',
      description: 'List all teams in the workspace',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'linear_list_projects',
      description: 'List projects, optionally filtered by team name',
      inputSchema: {
        type: 'object',
        properties: {
          team: { type: 'string', description: 'Team name or key to filter by' },
          limit: { type: 'number', description: 'Max results (default 20)' },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  try {
    if (name === 'linear_my_issues') {
      const me = await linear.viewer;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const filter: any = { assignee: { id: { eq: me.id } } };
      if (args?.state) filter.state = { name: { eq: args.state } };
      const issues = await linear.issues({ filter, first: (args?.limit as number) || 20 });
      const items = await Promise.all(
        issues.nodes.map(async (i) => {
          const [state, team] = await Promise.all([i.state, i.team]);
          return `${team?.key ?? '?'}-${i.number} [${state?.name ?? '?'}] ${i.title}${i.description ? `\n  ${i.description.slice(0, 200)}` : ''}`;
        }),
      );
      return { content: [{ type: 'text', text: items.join('\n\n') || 'No issues found.' }] };
    }

    if (name === 'linear_search_issues') {
      const issues = await linear.issueSearch({
        query: args!.query as string,
        first: (args?.limit as number) || 20,
      });
      const items = await Promise.all(
        issues.nodes.map(async (i) => {
          const [state, team] = await Promise.all([i.state, i.team]);
          return `${team?.key ?? '?'}-${i.number} [${state?.name ?? '?'}] ${i.title}`;
        }),
      );
      return { content: [{ type: 'text', text: items.join('\n') || 'No issues found.' }] };
    }

    if (name === 'linear_get_issue') {
      const id = args!.id as string;
      // UUID has dashes in the middle; identifier like ENG-123 has no underscores and matches team-number pattern
      const isIdentifier = /^[A-Z]+-\d+$/.test(id);
      let issue;
      if (isIdentifier) {
        const results = await linear.issueSearch({ query: id, first: 1 });
        issue = results.nodes[0];
      } else {
        issue = await linear.issue(id);
      }
      if (!issue) return { content: [{ type: 'text', text: 'Issue not found.' }] };
      const [state, team, assignee, comments] = await Promise.all([
        issue.state,
        issue.team,
        issue.assignee,
        issue.comments({ first: 5 }),
      ]);
      const commentLines = await Promise.all(
        comments.nodes.map(async (c) => {
          const user = await c.user;
          return `  ${user?.name ?? 'unknown'}: ${c.body?.slice(0, 300)}`;
        }),
      );
      const text = [
        `${team?.key ?? '?'}-${issue.number}: ${issue.title}`,
        `State: ${state?.name ?? '?'} | Priority: ${issue.priorityLabel ?? 'None'} | Assignee: ${assignee?.name ?? 'Unassigned'}`,
        `URL: ${issue.url}`,
        issue.description ? `\n${issue.description.slice(0, 1000)}` : '',
        commentLines.length ? `\nComments:\n${commentLines.join('\n')}` : '',
      ].filter(Boolean).join('\n');
      return { content: [{ type: 'text', text: text }] };
    }

    if (name === 'linear_list_teams') {
      const teams = await linear.teams();
      const items = teams.nodes.map((t) => `${t.key}: ${t.name}`);
      return { content: [{ type: 'text', text: items.join('\n') || 'No teams found.' }] };
    }

    if (name === 'linear_list_projects') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const filter: any = args?.team
        ? { accessibleTeams: { some: { name: { containsIgnoreCase: args.team } } } }
        : undefined;
      const projects = await linear.projects({ filter, first: (args?.limit as number) || 20 });
      const items = projects.nodes.map(
        (p) => `${p.name} [${p.state}]${p.description ? ` — ${p.description.slice(0, 100)}` : ''}`,
      );
      return { content: [{ type: 'text', text: items.join('\n') || 'No projects found.' }] };
    }

    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
