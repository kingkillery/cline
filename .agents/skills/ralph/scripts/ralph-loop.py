#!/usr/bin/env python3
"""Plan-first Ralph loop runner for Codex CLI.

Example:
  python ralph-loop.py --prompt-file prompt.md --iterations 10 --complete "<promise>COMPLETE</promise>"
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--prompt-file', required=True)
parser.add_argument('--iterations', type=int, default=10)
parser.add_argument('--complete', default='COMPLETE')
parser.add_argument('--model', default=None)
parser.add_argument('--plan-file', default='ralph-plan.json')
args = parser.parse_args()

prompt_path = Path(args.prompt_file)
prompt = prompt_path.read_text(encoding='utf-8')

def run_codex_exec(message: str) -> str:
    cmd = ['codex', 'exec']
    if args.model:
        cmd += ['-m', args.model]
    cmd.append(message)
    result = subprocess.run(cmd, capture_output=True, text=True)
    return (result.stdout or '') + (result.stderr or '')


def extract_json_block(text: str) -> dict:
    start = text.find('{')
    end = text.rfind('}')
    if start == -1 or end == -1 or end <= start:
        raise ValueError('No JSON object found in output')
    return json.loads(text[start:end + 1])


def plan_prompt(user_prompt: str) -> str:
    return (
        "Create a comprehensive execution plan as JSON.\\n"
        "Output ONLY JSON.\\n"
        "Required schema:\\n"
        "{\\n"
        "  \\"questions\\": [\\"...\\"] or [],\\n"
        "  \\"completion\\": \\"<promise>COMPLETE</promise>\\",\\n"
        "  \\"steps\\": [\\n"
        "    {\\"id\\": \\"step_1\\", \\"title\\": \\"...\\", \\"objective\\": \\"...\\", \\"acceptance\\": [\\"...\\"]}\\n"
        "  ]\\n"
        "}\\n\\n"
        "Rules:\\n"
        "- If you need user input, put the questions in the questions array and keep steps empty.\\n"
        "- Keep steps minimal and ordered.\\n"
        "- Use the completion phrase exactly in completion.\\n\\n"
        f"User task:\\n{user_prompt}"
    )


plan_path = Path(args.plan_file)
plan_data = None

if plan_path.exists():
    try:
        plan_data = json.loads(plan_path.read_text(encoding='utf-8'))
        print(f"Loaded existing plan from {plan_path}")
    except Exception:
        plan_data = None

if plan_data is None:
    print("=== Planning Phase ===")
    plan_output = run_codex_exec(plan_prompt(prompt))
    try:
        plan_data = extract_json_block(plan_output)
    except Exception as exc:
        print("Failed to parse plan output.")
        print(plan_output)
        raise SystemExit(1) from exc

    plan_path.write_text(json.dumps(plan_data, indent=2), encoding='utf-8')

questions = plan_data.get('questions') or []
if questions:
    print("\nPlanner needs more input:")
    for q in questions:
        print(f"- {q}")
    print("\nUpdate the prompt file with answers, then rerun.")
    raise SystemExit(2)

steps = plan_data.get('steps') or []
if not steps:
    print("No steps provided in plan. Exiting.")
    raise SystemExit(1)

completion_token = plan_data.get('completion') or args.complete

def step_prompt(step: dict, user_prompt: str) -> str:
    return (
        "You are executing a single step in a larger plan.\\n"
        f"Step ID: {step.get('id')}\\n"
        f"Title: {step.get('title')}\\n"
        f"Objective: {step.get('objective')}\\n"
        f"Acceptance: {step.get('acceptance')}\\n\\n"
        "Do the minimum work needed for this step.\\n"
        "If the step is complete, say DONE for this step.\\n\\n"
        f"Full task context:\\n{user_prompt}"
    )


for i in range(1, args.iterations + 1):
    print(f"\n=== Iteration {i}/{args.iterations} ===")
    all_done = True

    for step in steps:
        output = run_codex_exec(step_prompt(step, prompt))
        print(output)

        if "DONE" not in output:
            all_done = False

    if completion_token and completion_token in output:
        print("Completion criteria met.")
        raise SystemExit(0)

    if all_done:
        print("All steps reported DONE. Marking complete.")
        raise SystemExit(0)

print('Max iterations reached without completion.')
sys.exit(1)
