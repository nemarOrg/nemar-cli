# Testing Standards - NO MOCKS Policy

## Core Philosophy: Test Reality, Not Fiction
**Why NO MOCKS?** Mocks test your assumptions, not your code.  
**Real bugs** hide in integration points, not unit logic.  
**Better approach:** No test is better than a false-confidence mock test.

## [STRICT] NO MOCKS, NO FAKE DATA
Never use mocks, stubs, or fake datasets. If real testing isn't possible, don't write tests.
- **No mock objects** - Use real implementations
- **No mock datasets** - Use actual sample data
- **No stub services** - Connect to real test instances
- **Alternative:** Ask user for sample data or test environment setup

## When to Write Tests
- **DO:** Test with real data and actual dependencies
- **DO:** Use test databases with real schemas
- **DO:** Test against actual file systems
- **DON'T:** Write tests if only mocks would work
- **DON'T:** Create artificial test scenarios

## Test Structure
```
tests/
  conftest.py          # Real test fixtures
  sample_data/         # Actual data samples (user-provided)
    valid/
    invalid/
  integration/         # Tests with real dependencies
    test_database.py   # Real DB connection
    test_api.py        # Real API calls
```

## Frameworks (Language-Specific)
- **Python:** `pytest` with real fixtures
- **JavaScript:** `vitest` or `jest` (no mocking libs)
- **Database:** Use test DB with real migrations
- **APIs:** Test against staging/local instances

## Writing Real Tests
```python
# GOOD: Tests actual behavior
def test_user_creation(real_db):
    """Tests that users are actually persisted."""
    user = User.create(email="test@example.com")
    # This catches: ORM issues, DB constraints, connection problems
    assert real_db.query(User).filter_by(email="test@example.com").first()

# BAD: Tests nothing meaningful
# def test_user_creation(mock_db):  # NO!
#     mock_db.return_value = User()  # Tests that Python works?
```

**Ask:** What am I actually testing? Would this catch real bugs?

## [STRICT] Test the entry point, not the piece

**Why:** a test that calls a helper directly cannot catch a regression in how the
*caller* derives that helper's inputs, which is where these bugs actually live.

**The rule:** if production reaches a behaviour through an orchestration function
or an HTTP route, the test drives THAT. Exercising an exported helper, a SQL
constant, or a pure sub-function in isolation is a supplement, never the coverage.

**Smells that mean the test cannot fail:**
- It loops over a parameter the function under test does not accept.
- It re-implements production logic locally (fetch-then-slice, a hand-copied SQL
  string) and then asserts on its own arithmetic.
- Its assertion is satisfied by how the fixture was built, not by behaviour.
- The fixture is too small to reach the boundary it claims to probe.

**Never hand-copy a SQL statement into a test.** Export the real one and import it.
A copy tests itself: edit the production statement and the test still passes.

**Evidence (epic #1144, four separate instances):** a count test looped over a
`limit` its function had no parameter for; a paging test used offsets that stayed
inside the buggy window; a sweep's own function and HTTP route were never invoked
by any test, so removing its bound and transposing its counters both left 165
tests green; a `?reset=1` SQL string was hand-copied, so dropping a column from
the real route passed everything.

## [STRICT] Prove the test fails

**A test nobody has watched fail is not yet a test.**

Before claiming a test covers something, mutate the single line of production code
it targets, run it, and confirm it fails for the expected reason. Then revert and
confirm `git status --porcelain` is clean.

**One perturbation at a time.** Reverting a whole change proves the change matters;
reverting one piece at a time proves each piece is individually guarded. Two fixes
reverted together mask each other: in epic #1144 a candidate-window fix and a count
fix were verified as a pair, and the window half turned out to have no coverage at
all.

**Check the mutation actually applied.** A substitution that silently matched
nothing, followed by a green run, reads exactly like a passing verification.

**When real data cannot falsify the rule, say so in the test.** If the production
corpus makes two implementations agree (epic #1144: no dataset had a multi-group
store, so `max` and `sum` were indistinguishable across the whole catalog), then a
synthetic fixture is the only thing standing between a transposed rule and silent
corruption. Write that in the comment, or the next reader deletes the "redundant"
fixture.

## Test Data Management
- **Sample data:** Request from user or use production samples
- **Test databases:** Use Docker containers or test instances
- **File fixtures:** Use actual files, not generated ones
- **API testing:** Point to real test endpoints

## CI Integration
- Run tests with real test environment
- Skip tests if environment unavailable
- Document required test infrastructure
- See `ci_cd.md` for pipeline setup

## When Real Testing Seems Impossible
**Think creatively before giving up:**
- Can you use Docker for a test database?
- Can you record real API responses for replay?
- Can you get anonymized production data samples?
- Can you create a minimal test environment?

**If truly impossible:**
1. Document needs in `test_requirements.md`
2. Explain to user what's needed and why
3. Ask for:
   - Sample datasets from production
   - Test environment access
   - Sandbox API credentials
4. **Be honest:** "Without real test data, I cannot verify this works"

## The Testing Mindset
- **You're not checking boxes** - you're building confidence
- **Every test should** catch at least one real bug category
- **Think:** "Will this test save someone from a 3am wake-up call?"

---
*NO MOCKS. Real tests build real confidence. When in doubt, ask for real data.*