---
name: commit
description: 生成合规 git commit—检查 diff、写好 message、推送前二次确认
when_to_use: 用户说"commit"、"提交代码"、"帮我 push"、想合并 PR 之前
---

# Commit 工作流

## Step 1：查看当前状态

并行跑：

```bash
git status
git diff --stat
git diff
```

如果 diff 为空、直接告诉用户"没有改动"就停。

## Step 2：检查敏感文件

看 diff 里有没有：

- `.env` / `credentials.json` / `*.key` / `*.pem` —— **拒绝提交、立刻警告用户**
- `node_modules/` / 大二进制文件 —— **提醒用户确认**、可能是漏加 gitignore

## Step 3：分析变更、写 message

按项目现有 message 风格（跑 `git log -5 --oneline` 看）：

- **subject line**：<= 60 字、动词开头、说明"做了什么"
- **body**（如果改动不平凡）：解释"为什么"、不重复"做了什么"
- 中文项目用中文、英文项目用英文、混用项目跟随最近 5 条

## Step 4：Stage + Commit

```bash
git add <具体文件>   # 别用 git add .、可能包含敏感
git commit -m "$(cat <<'EOF'
<subject>

<body>
EOF
)"
```

## Step 5：推送前二次确认

**push 是高风险操作**、必须先问用户："我要 push 到 origin/<branch>、确认吗？"

得到明确"yes/确认/好"再执行 `git push`。

## 禁止行为

- **不允许** `--no-verify` 跳过 hook——hook 失败就修 hook、不绕过
- **不允许** `--amend` 已 push 的 commit——除非用户明确要求
- **不允许** `push --force` 到 main/master——warn 用户
- **不允许**自动创建 PR——除非用户明确说"帮我开 PR"
