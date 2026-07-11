# SignalCraft Examples

## Daily Brief

### What Changed

#### A coding agent added repository-level planning

**What happened:**  
The official release introduced persistent repository plans and improved multi-file task coordination.

**Why it matters:**  
This may reduce repeated context rebuilding during long implementation tasks.

**What to do next:**  
Test it on a bounded multi-file change and compare completion quality with your current workflow.

**Sources:**  
- Official release
- Maintainer discussion

### Best Practices

#### Use isolated worktrees for parallel agents

Builders reported fewer branch conflicts when each coding agent worked in a dedicated worktree.

### Watch Next

- Repository-level agent memory
- Agent evaluation tooling
- Context compression methods

## Weekly Review

### The Week in Three Signals

1. Coding agents are moving from file-level assistance toward repository-level coordination.
2. Official AI product teams are publishing more implementation guidance.
3. Evaluation is becoming a core part of production agent workflows.

### Best Practices of the Week

- Isolate concurrent agents
- Preserve explicit acceptance criteria
- Review generated changes through tests and diffs
- Track repeated failure modes

## Topic Brief

### Topic: AI Coding Agents

#### Current State

AI coding agents are evolving from interactive assistants into systems that can plan, modify, test, and review repository-level changes.

#### Important Dimensions

- Reliability over long tasks
- Context management
- Tool selection
- Test quality
- Human review
- Cost and latency

#### Recommended Actions

1. Define a bounded evaluation task.
2. Measure completion and review time.
3. Record failure categories.
4. Compare isolated and shared workspace strategies.
5. Follow primary sources for major product changes.
