import { config } from './config.mjs';
import { search as ragSearch } from './rag.mjs';
import { allMcpTools, callMcpTool } from './mcp.mjs';
import { listSkills, getSkill } from './skills.mjs';
import {
  videoReady,
  videoInfo,
  videoSizes,
  videoModelId,
  submitVideo,
  queryVideo,
  waitVideo,
  rememberVideoTask,
  latestVideoTask,
} from './video.mjs';
import {
  imageReady,
  imageInfo,
  imageSizes,
  imageModelId,
  submitImage,
  queryImage,
  waitImage,
  rememberImageTask,
  latestImageTask,
} from './image.mjs';

const RAG_TOOL = {
  type: 'function',
  function: {
    name: 'rag_search',
    description: '在用户上传的文档库中检索相关片段。回答需要引用资料、或问题涉及文档内容时使用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词，尽量是名词短语' },
        topK: { type: 'number', description: '返回条数，默认 5' },
      },
      required: ['query'],
    },
  },
};

function videoTools() {
  const { model, models, size } = videoInfo();
  const sizes = videoSizes();
  const waitSeconds = config.video.pollSeconds;

  return [
    {
      type: 'function',
      function: {
        name: 'generate_video',
        description:
          `根据文字描述生成一段 5 秒短视频（文生视频）。可选模型：${models.join('、')}，默认 ${model}。` +
          'plus 画质更好但只支持 720P，turbo 支持 480P/720P 且更快。' +
          `只在用户明确要求生成视频/动画时调用。提交后会在服务端等待最多 ${waitSeconds} 秒；` +
          '如果仍未完成，会返回 task_id，需要稍后用 check_video 查询。生成需要 1-5 分钟，且会产生费用。',
        parameters: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: '画面描述：主体、动作、环境、镜头、光线、风格。尽量具体。',
            },
            model: {
              type: 'string',
              enum: models,
              description: '视频模型；不传用默认值',
            },
            size: {
              type: 'string',
              enum: sizes,
              description: `分辨率，默认 ${size}。横屏 832*480/1280*720，竖屏 480*832/720*1280`,
            },
          },
          required: ['prompt'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'check_video',
        description:
          '查询文生视频任务的状态。成功时返回视频链接。task_id 可省略：默认查询本用户最近一次提交的视频任务。',
        parameters: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: 'generate_video 返回的 task_id；不确定就省略' },
          },
        },
      },
    },
  ];
}

function imageTools() {
  const { model, models, size, n } = imageInfo();
  const sizes = imageSizes();
  const waitSeconds = config.image.pollSeconds;

  return [
    {
      type: 'function',
      function: {
        name: 'generate_image',
        description:
          `根据文字描述生成图片（文生图）。可选模型：${models.join('、')}，默认 ${model}。` +
          `一次可生成 1-4 张，通常 10-30 秒。提交后最多等待 ${waitSeconds} 秒；` +
          '超时会返回 task_id，需要稍后用 check_image 查询。会产生费用。',
        parameters: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: '画面描述：主体、风格、构图、光线、色彩。尽量具体。',
            },
            model: {
              type: 'string',
              enum: models,
              description: '图片模型；不传用默认值',
            },
            size: {
              type: 'string',
              enum: sizes,
              description: `分辨率，默认 ${size}。竖图用 720*1280，横图用 1280*720`,
            },
            n: {
              type: 'number',
              enum: [1, 2, 3, 4],
              description: `生成张数，默认 ${n}。张数越多消耗的额度越多`,
            },
          },
          required: ['prompt'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'check_image',
        description:
          '查询文生图任务的状态。成功时返回图片链接。task_id 可省略：默认查询本用户最近一次提交的图片任务。',
        parameters: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: 'generate_image 返回的 task_id；不确定就省略' },
          },
        },
      },
    },
  ];
}

export function buildTools(tenant, enabled = {}) {
  const tools = [];
  if (enabled.rag) tools.push(RAG_TOOL);

  // 视频/图片都是异步任务，拆成「提交」+「查询」两个工具，避免一次工具调用把 Agent 卡几分钟
  if (enabled.video && videoReady()) tools.push(...videoTools());
  if (enabled.image && imageReady()) tools.push(...imageTools());

  // 技能：把 name + description 暴露给模型，由它决定什么时候加载正文
  const skills = enabled.skills === false ? [] : listSkills(tenant);
  if (skills.length) {
    tools.push({
      type: 'function',
      function: {
        name: 'use_skill',
        description:
          '加载某个 Skill 的完整操作流程。当任务与下面某个 Skill 的描述匹配时，先调用它拿到步骤，再按步骤回答；不匹配就不要调用。\n可用 Skill：\n' +
          skills.map((s) => `- ${s.name}：${s.description || '无描述'}`).join('\n'),
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', enum: skills.map((s) => s.name), description: 'Skill 名' },
          },
          required: ['name'],
        },
      },
    });
  }

  tools.push(...allMcpTools(tenant));
  return tools;
}

function formatVideoResult(r, model) {
  const { model: defaultModel, size } = videoInfo();
  const actualModel = model || defaultModel;
  const actualSize = r.usage?.size || r.usage?.video_ratio || size;

  if (r.status === 'SUCCEEDED' && r.videoUrl) {
    return [
      '视频已生成。',
      `VIDEO_URL: ${r.videoUrl}`,
      `模型：${actualModel}${actualSize ? ` · ${actualSize}` : ''}`,
      '厂商链接约 24 小时有效，请尽快下载或转存。',
    ].join('\n');
  }

  if (r.status === 'FAILED') {
    return `视频生成失败：${r.message || '未知原因'}\ntask_id: ${r.taskId}`;
  }
  if (r.status === 'CANCELED') {
    return `视频任务已取消（task_id: ${r.taskId}）。`;
  }
  if (r.status === 'UNKNOWN') {
    return `找不到该视频任务（task_id: ${r.taskId}），可能已超过 24 小时有效期。`;
  }

  return [
    `视频仍在生成中（task_id: ${r.taskId}，状态 ${r.status}）。`,
    '通常需要 1-5 分钟。请把 task_id 原样告诉用户；稍后用户问“视频好了吗”时，直接调用 check_video 即可（task_id 可省略）。',
  ].join('\n');
}

function formatImageResult(r, model) {
  const { model: defaultModel } = imageInfo();
  const actualModel = model || defaultModel;

  if (r.status === 'SUCCEEDED' && r.urls?.length) {
    return [
      `图片已生成（共 ${r.urls.length} 张）。`,
      ...r.urls.map((u) => `IMAGE_URL: ${u}`),
      `模型：${actualModel}`,
      '厂商链接约 24 小时有效，请尽快下载或转存。',
    ].join('\n');
  }

  if (r.status === 'FAILED') {
    return `图片生成失败：${r.message || '未知原因'}\ntask_id: ${r.taskId}`;
  }
  if (r.status === 'CANCELED') {
    return `图片任务已取消（task_id: ${r.taskId}）。`;
  }
  if (r.status === 'UNKNOWN') {
    return `找不到该图片任务（task_id: ${r.taskId}），可能已超过 24 小时有效期。`;
  }

  return [
    `图片仍在生成中（task_id: ${r.taskId}，状态 ${r.status}）。`,
    '通常 10-30 秒。稍后用户追问时，直接调用 check_image（task_id 可省略）。',
  ].join('\n');
}

export async function executeTool(tenant, name, args, ctx = {}) {
  if (name === 'use_skill') {
    const skill = getSkill(tenant, String(args.name || ''));
    if (!skill) return `没有找到 Skill：${args.name}`;
    return `# Skill：${skill.name}\n\n${skill.body}`;
  }

  if (name === 'generate_video') {
    if (!videoReady()) return '视频生成未配置：需要 DASHSCOPE_API_KEY 或 VIDEO_API_KEY。';

    const model = videoModelId(args.model);
    const submitted = await submitVideo({
      prompt: args.prompt,
      model,
      size: args.size,
      signal: ctx.signal,
    });
    rememberVideoTask(tenant, submitted.taskId);

    const result = await waitVideo(submitted.taskId, {
      maxWaitMs: config.video.pollSeconds * 1000,
      intervalMs: 5000,
      signal: ctx.signal,
    });
    return formatVideoResult(result, model);
  }

  if (name === 'check_video') {
    if (!videoReady()) return '视频生成未配置：需要 DASHSCOPE_API_KEY 或 VIDEO_API_KEY。';

    const taskId = String(args.task_id || latestVideoTask(tenant) || '').trim();
    if (!taskId) return '还没有提交过视频任务。先让用户描述画面，再调用 generate_video。';

    const result = await queryVideo(taskId, { signal: ctx.signal });
    return formatVideoResult(result, videoModelId());
  }

  if (name === 'generate_image') {
    if (!imageReady()) return '图片生成未配置：需要 DASHSCOPE_API_KEY 或 IMAGE_API_KEY。';

    const model = imageModelId(args.model);
    const submitted = await submitImage({
      prompt: args.prompt,
      model,
      size: args.size,
      n: args.n,
      signal: ctx.signal,
    });
    rememberImageTask(tenant, submitted.taskId);

    const result = await waitImage(submitted.taskId, {
      maxWaitMs: config.image.pollSeconds * 1000,
      intervalMs: 3000,
      signal: ctx.signal,
    });
    return formatImageResult(result, model);
  }

  if (name === 'check_image') {
    if (!imageReady()) return '图片生成未配置：需要 DASHSCOPE_API_KEY 或 IMAGE_API_KEY。';

    const taskId = String(args.task_id || latestImageTask(tenant) || '').trim();
    if (!taskId) return '还没有提交过图片任务。先让用户描述画面，再调用 generate_image。';

    const result = await queryImage(taskId, { signal: ctx.signal });
    return formatImageResult(result, imageModelId());
  }

  if (name === 'rag_search') {
    const hits = await ragSearch(tenant, args.query, Number(args.topK) || 5);
    if (!hits.length) return '文档库中没有检索到相关内容。';
    return hits
      .map((h, i) => `[${i + 1}] 来源：${h.docName}（相似度 ${h.score}）\n${h.text}`)
      .join('\n\n');
  }

  if (name.includes('__')) return callMcpTool(tenant, name, args);

  return `未知工具: ${name}`;
}
