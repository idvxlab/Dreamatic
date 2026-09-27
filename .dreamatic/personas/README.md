# 身份配置（Personas）

每个 `.md` 文件 = 一个身份（System Prompt）。

## 使用方式

```powershell
python cli.py --persona researcher       # 加载 researcher.md
python cli.py --persona coder            # 加载 coder.md
python cli.py --list-personas            # 查看所有可用身份
```

在 Skill 里也可以引用 persona（可选）：
```yaml
# skills/my-skill.md 的 frontmatter 里加：
persona: researcher   # 会自动加载 personas/researcher.md 的内容
```

## 新建身份

直接新建一个 `.md` 文件，内容就是 System Prompt，支持 Markdown 格式：

```markdown
你是一个[角色]。

你擅长：
- 能力 1
- 能力 2

回答时先给结论，再展开细节。用中文。
```

无需任何特殊标记，写完即可使用。
