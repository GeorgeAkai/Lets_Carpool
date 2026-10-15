# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues on **GeorgeAkai/Lets_Carpool** (the `personal` remote) — not the `origin` remote (LLC-organisation/Lets_Carpool). Use the `gh` CLI for all operations.

Because this repo has two remotes, always pass `--repo GeorgeAkai/Lets_Carpool` explicitly rather than relying on `gh`'s auto-detection, which may resolve to `origin` instead.

## Conventions

- **Create an issue**: `gh issue create --repo GeorgeAkai/Lets_Carpool --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --repo GeorgeAkai/Lets_Carpool --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --repo GeorgeAkai/Lets_Carpool --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --repo GeorgeAkai/Lets_Carpool --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --repo GeorgeAkai/Lets_Carpool --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --repo GeorgeAkai/Lets_Carpool --comment "..."`

## When a skill says "publish to the issue tracker"

Create a GitHub issue on GeorgeAkai/Lets_Carpool.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --repo GeorgeAkai/Lets_Carpool --comments`.
