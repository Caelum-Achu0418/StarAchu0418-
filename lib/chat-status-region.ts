// lib/chat-status-region.ts
// 自定义状态栏（状态区）：会话级配置 + 默认预设宏解析。
//
// 机制：默认预设的「内心想法」章节改为宏 {{statusRegionSection}}（主动消息示例行
// 对应 {{statusRegionExampleLine}}），按本模块的会话配置解析：
//   native（默认）→ 原章节文本，字节级等于历史版本，所有存量用户无感；
//   off           → 空，整节从提示词消失，AI 自然不再输出 [内心]；
//   custom        → 「## 状态栏」+ 契约整段正文（契约自带【逻辑】【格式】与包裹要求）。
// 只有包含宏的预设（默认预设天生包含；社区预设作者可自愿声明）支持自定义——
// 不含宏的预设完全不受本机制影响，聊天信息页的入口会置灰。
//
// 渲染侧配套：custom 模式下生成的消息盖 statusRegionMode 戳，折叠区不再画
// 便利贴容器，改由用户的渲染代码（沙盒 iframe，AI 壳内原文经 window.STATUS_RAW
// 与 {{RAW}} 注入）接管。原生时期的消息永远按原生渲染，切换可逆。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";

export type StatusRegionMode = "native" | "off" | "custom";

export type StatusRegionConfig = {
    mode: StatusRegionMode;
    /** 输出契约：告诉 AI [状态栏] 壳内输出什么（custom 模式生效） */
    contract: string;
    /** 输出渲染：完整 HTML（可含 JS），沙盒 iframe 执行，接管折叠区绘制 */
    renderHtml: string;
};

const STORAGE_KEY = "ai_phone_chat_status_region_v1";
registerKvMigration(STORAGE_KEY);

/** 状态栏方案库在 css-scheme-storage 里的 target 键（负载=契约+渲染+示例数据 JSON） */
export const STATUS_REGION_SCHEME_TARGET = "chat_status_region";

export const STATUS_REGION_SECTION_MACRO = "{{statusRegionSection}}";
export const STATUS_REGION_EXAMPLE_MACRO = "{{statusRegionExampleLine}}";
export const STATUS_REGION_COMPOSITION_MACRO = "{{statusRegionComposition}}";
export const STATUS_REGION_FULL_EXAMPLE_MACRO = "{{statusRegionFullExample}}";

/** 原「## 状态数值」+「## 内心想法」章节原文——native 挡解析值，必须与历史版本逐字一致。
 *  状态数值也归入状态区：关闭原生后 [好感度:X] 等标签一并从提示词移除（好感度等会话状态随之停更）。 */
export const NATIVE_STATUS_REGION_SECTION = [
    "## 状态数值",
    "【逻辑】基于当前状态 {{state}}，根据本轮对话的情绪起伏进行实时增减（范围 0-100）。",
    "【格式】[好感度:X][占有欲:X][焦虑值:X]",
    "【示例】[好感度:85][占有欲:60][焦虑值:45]",
    "",
    "## 内心想法",
    "【逻辑】反映角色在回复前的真实心理活动、潜台词或情绪波动。",
    "【格式】[内心]在此处填写内心的潜台词[/内心]",
].join("\n");

/** 主动消息类条目里的静默输出格式原文（静默行+状态值行+内心行整块归宏） */
export const NATIVE_STATUS_REGION_EXAMPLE_LINE = [
    "如果决定静默，按照以下格式输出：",
    "[好感度:X][占有欲:X][焦虑值:X]",
    "[内心]你的所有内心想法写在这里。[/内心]",
].join("\n");

/** 文字聊天模式开头的【输出构成】行原文 */
export const NATIVE_STATUS_REGION_COMPOSITION =
    "【输出构成】输出格式由四个部分组成：状态数值、内心想法、聊天消息、富媒体动作（可选）。";

/** 「## 完整示例」里的状态值+内心两行原文 */
export const NATIVE_STATUS_REGION_FULL_EXAMPLE = [
    "[好感度:72][占有欲:25][焦虑值:15]",
    "[内心]等了{{user}}一整晚，回复这么冷淡，心里有点堵得慌。[/内心]",
].join("\n");

export const DEFAULT_STATUS_REGION_CONFIG: StatusRegionConfig = {
    mode: "native",
    contract: "",
    renderHtml: "",
};

function loadAll(): Record<string, StatusRegionConfig> {
    if (typeof window === "undefined") return {};
    try {
        const parsed = JSON.parse(kvGet(STORAGE_KEY) || "{}") as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as Record<string, StatusRegionConfig>
            : {};
    } catch {
        return {};
    }
}

export function getStatusRegionConfig(sessionId: string): StatusRegionConfig {
    const raw = loadAll()[sessionId];
    if (!raw || typeof raw !== "object") return { ...DEFAULT_STATUS_REGION_CONFIG };
    const mode = raw.mode === "off" || raw.mode === "custom" ? raw.mode : "native";
    return {
        mode,
        contract: typeof raw.contract === "string" ? raw.contract : "",
        renderHtml: typeof raw.renderHtml === "string" ? raw.renderHtml : "",
    };
}

export function saveStatusRegionConfig(sessionId: string, config: StatusRegionConfig): void {
    if (typeof window === "undefined") return;
    const all = loadAll();
    if (config.mode === "native" && !config.contract.trim() && !config.renderHtml.trim()) {
        delete all[sessionId];
    } else {
        all[sessionId] = config;
    }
    kvSet(STORAGE_KEY, JSON.stringify(all));
}

/** custom 是否真正生效（契约与渲染都要有内容，缺一回退 native 行为） */
export function isCustomStatusRegionActive(config: StatusRegionConfig): boolean {
    return config.mode === "custom" && !!config.contract.trim() && !!config.renderHtml.trim();
}

/** {{statusRegionSection}} 的解析值 */
export function resolveStatusRegionSection(config: StatusRegionConfig): string {
    if (config.mode === "off") return "";
    if (isCustomStatusRegionActive(config)) {
        // 契约即「## 状态栏」章节的整个正文（含【逻辑】【格式】与 [状态栏] 包裹要求），不再套固定信封
        return "## 状态栏\n" + config.contract.trim();
    }
    return NATIVE_STATUS_REGION_SECTION;
}

/** {{statusRegionExampleLine}} 的解析值（主动消息类条目的静默输出格式块） */
export function resolveStatusRegionExampleLine(config: StatusRegionConfig): string {
    if (config.mode === "off") return "如果决定静默，不输出任何内容。";
    if (isCustomStatusRegionActive(config)) {
        return "如果决定静默，按照以下格式输出：\n[状态栏]（按状态栏契约输出）[/状态栏]";
    }
    return NATIVE_STATUS_REGION_EXAMPLE_LINE;
}

/** {{statusRegionComposition}} 的解析值（文字聊天模式的【输出构成】行） */
export function resolveStatusRegionComposition(config: StatusRegionConfig): string {
    if (config.mode === "off") return "【输出构成】输出格式由两个部分组成：聊天消息、富媒体动作（可选）。";
    if (isCustomStatusRegionActive(config)) {
        return "【输出构成】输出格式由三个部分组成：状态栏、聊天消息、富媒体动作（可选）。";
    }
    return NATIVE_STATUS_REGION_COMPOSITION;
}

/** {{statusRegionFullExample}} 的解析值（「## 完整示例」里的状态值+内心行） */
export function resolveStatusRegionFullExample(config: StatusRegionConfig): string {
    if (config.mode === "off") return "";
    if (isCustomStatusRegionActive(config)) return "[状态栏]（按状态栏契约输出）[/状态栏]";
    return NATIVE_STATUS_REGION_FULL_EXAMPLE;
}

/** 预设是否声明了状态区宏（聊天信息页自定义入口的可用性判定） */
export function presetSupportsStatusRegion(presetPromptTexts: string[]): boolean {
    return presetPromptTexts.some(text => text.includes(STATUS_REGION_SECTION_MACRO));
}
