/**
 * 已验证可直接连接（无需 key / OAuth）的公开 MCP server。
 * 全部实测过：tools/list 能正常返回。
 */
export const MCP_PRESETS = [
  {
    id: 'deepwiki',
    name: 'DeepWiki',
    url: 'https://mcp.deepwiki.com/mcp',
    desc: '查 GitHub 仓库的架构与文档',
  },
  {
    id: 'context7',
    name: 'Context7',
    url: 'https://mcp.context7.com/mcp',
    desc: '查框架/库的最新版本文档',
  },
  {
    id: 'exa',
    name: 'Exa 搜索',
    url: 'https://mcp.exa.ai/mcp',
    desc: '联网搜索与网页抓取',
  },
];
