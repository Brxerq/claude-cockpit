# Checks

Run all of these before saying done. All must pass.

    node plugins/cockpit/hooks/route.test.mjs
    node plugins/cockpit/hooks/plan.test.mjs
    node plugins/cockpit/hooks/cache.test.mjs
    CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test plugins/cockpit
    claude plugin validate plugins/cockpit

This project has no typecheck and no lint. No TypeScript compiler is installed.
Passing tests do not prove a live load. Sessions run the installed copy in ~/.claude/plugins/cache.
To see a change live: commit, push, update the plugin, start a new session.
