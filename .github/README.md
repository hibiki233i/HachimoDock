# Claude PR 自动审查

`claude-review.yml` 按 Anthropic 官方 Claude Code Action 的自动审查方式配置，读取根目录 `CLAUDE.md`。同仓库分支的非草稿 PR 在创建、更新、重新打开或转为可审查时运行；后续提交会取消旧审查并审查最新版本。

在 fork 的 **Settings → Secrets and variables → Actions** 添加下列任一 repository secret：

- `CLAUDE_CODE_OAUTH_TOKEN`：通过 `claude setup-token` 获取的 Claude Code 订阅凭据。
- `ANTHROPIC_API_KEY`：Anthropic API key。

同时存在时优先使用 OAuth。凭据通过 Actions secret 注入，不进入源码；缺少凭据时检查会明确失败并给出设置入口。

工作流使用显式 `github_token: ${{ github.token }}`，由仓库 Actions token 发布意见，无需额外 GitHub PAT 或安装 Claude GitHub App。权限限于读取源码和发布 PR/issue 评论。同仓库分支 PR 可获取审查凭据；来自其他 fork 的 PR 需维护者先评估，再按本仓库分支流程处理。

fork 的 Actions 需要启用。此配置不合并 PR，不执行仓库脚本，也不把自动审查的结果视为构建或实机测试结果。

官方说明：[自动审查示例](https://github.com/anthropics/claude-code-action/blob/main/docs/solutions.md)、[接入与凭据](https://github.com/anthropics/claude-code-action/blob/main/docs/setup.md)。
