# Test Before Bulk Convention

Never run a batch operation without testing one first.

## The Process

1. **Read the skill first.** Don't write throwaway scripts. If a skill exists, use it.
2. **Hone the prompt/logic.** Get the output format right before running anything.
3. **Test on 3-5 items.** Use the isolated test environment and supported dry runs. Permitted test commits prove the complete write/read path; do not publish a production backfill.
4. **Check the work yourself.** Read the actual output. Is quality pristine? Titles good? Entities extracted? Back-links created? Format clean?
5. **Fix what's wrong.** Update the skill, not a one-off script. The skill is the durable artifact.
6. **Only then: bulk execute.** Use existing bounded resumable workflow batches, visible progress and cancellation. The separate 10 → 100 → 500 ramp is outside this adoption.

## Why This Matters

One bad bulk run can write 170 mediocre pages that are harder to fix than to do
right the first time. The marginal cost of testing 5 first is near zero. The cost
of cleaning up a bad bulk run is enormous.

Quality is only half the failure surface. The other half is the **silent
zero-output run**: an embedding backfill once burned thousands of API calls
over half an hour and wrote zero rows — every insert failed on a NOT NULL
constraint, and the script's own logging never noticed. Exit code 0, money
spent, database unchanged. A 10-item trial with a count-before/count-after
check would have caught it in 30 seconds. "The script ran without errors" is
not the same as "the output exists."

## The Progressive Ramp (10 → 100 → 500 → full)

A 5-item quality test is necessary but not sufficient. For any operation that
