import pytest

from platform_worker.registry.expr import ExpressionError, bind, references

CTX = {"inputs": {"repo": "o/r", "n": 3}, "steps": {"prep": {"output": {"workspace": "w1", "files": ["a", "b"]}}},
       "run": {"id": "r1"}}


def test_whole_expression_keeps_type():
    assert bind("{{ inputs.n }}", CTX) == 3
    assert bind("{{steps.prep.output.files}}", CTX) == ["a", "b"]


def test_interpolation_and_nesting():
    assert bind({"t": "repo {{ inputs.repo }} in {{ steps.prep.output.workspace }}", "l": ["{{run.id}}"]}, CTX) == \
        {"t": "repo o/r in w1", "l": ["r1"]}
    assert bind("first={{ steps.prep.output.files.0 }}", CTX) == "first=a"


def test_missing_path_is_an_error():
    with pytest.raises(ExpressionError, match="steps.nope"):
        bind("{{ steps.nope.output.x }}", CTX)


def test_references():
    assert references({"a": "{{ inputs.repo }}", "b": ["x {{steps.prep.output.workspace}}"]}) == \
        ["inputs.repo", "steps.prep.output.workspace"]
