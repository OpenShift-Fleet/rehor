"""Tests for the post_pr.py wrapper script."""

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Add parent directory to path to import the wrapper
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import post_pr


class TestNormalizeMemoryUrl:
    """Test normalize_memory_url function."""

    def test_normalize_valid_url(self):
        """Test normalization of valid URL."""
        result = post_pr.normalize_memory_url("http://localhost:8080")
        assert result == "http://localhost:8080"

    def test_normalize_url_with_mcp_suffix(self):
        """Test normalization strips /mcp suffix."""
        result = post_pr.normalize_memory_url("http://localhost:8080/mcp")
        assert result == "http://localhost:8080"

    def test_normalize_url_with_mcp_uppercase(self):
        """Test normalization strips /MCP suffix (case-insensitive)."""
        result = post_pr.normalize_memory_url("http://localhost:8080/MCP")
        assert result == "http://localhost:8080"

    def test_normalize_url_with_trailing_slash(self):
        """Test normalization strips trailing slashes."""
        result = post_pr.normalize_memory_url("http://localhost:8080/")
        assert result == "http://localhost:8080"

    def test_normalize_url_with_mcp_and_slash(self):
        """Test normalization strips /mcp/ suffix."""
        result = post_pr.normalize_memory_url("http://localhost:8080/mcp/")
        assert result == "http://localhost:8080"

    def test_normalize_empty_url(self):
        """Test normalization returns default for empty string."""
        result = post_pr.normalize_memory_url("")
        assert result == "http://localhost:8080"

    def test_normalize_none_url(self):
        """Test normalization returns default for None."""
        result = post_pr.normalize_memory_url(None)
        assert result == "http://localhost:8080"

    def test_normalize_non_string_url(self):
        """Test normalization returns default for non-string input."""
        result = post_pr.normalize_memory_url(12345)
        assert result == "http://localhost:8080"

    def test_normalize_url_without_scheme(self):
        """Test normalization returns default for URL without scheme."""
        result = post_pr.normalize_memory_url("localhost:8080")
        assert result == "http://localhost:8080"

    def test_normalize_https_url(self):
        """Test normalization works with HTTPS URLs."""
        result = post_pr.normalize_memory_url("https://example.com:8080/mcp")
        assert result == "https://example.com:8080"


class TestGetTask:
    """Test get_task function."""

    @patch("post_pr.http_request")
    def test_get_task_success(self, mock_http):
        """Test successful task retrieval."""
        mock_http.return_value = {
            "items": [
                {
                    "external_key": "TEST-123",
                    "jira_key": "TEST-123",
                    "pr_url": "https://github.com/org/repo/pull/1",
                    "pr_number": 1,
                },
                {
                    "external_key": "TEST-456",
                    "jira_key": "TEST-456",
                    "pr_url": "https://github.com/org/repo/pull/2",
                    "pr_number": 2,
                },
            ]
        }

        task = post_pr.get_task("TEST-123")

        assert task is not None
        assert task["external_key"] == "TEST-123"
        assert task["pr_number"] == 1

    @patch("post_pr.http_request")
    def test_get_task_not_found(self, mock_http):
        """Test task not found."""
        mock_http.return_value = {
            "items": [
                {
                    "external_key": "TEST-456",
                    "jira_key": "TEST-456",
                    "pr_url": "https://github.com/org/repo/pull/2",
                    "pr_number": 2,
                },
            ]
        }

        task = post_pr.get_task("TEST-123")

        assert task is None

    @patch("post_pr.http_request")
    def test_get_task_empty_response(self, mock_http):
        """Test empty response from memory server."""
        mock_http.return_value = None

        task = post_pr.get_task("TEST-123")

        assert task is None

    @patch("post_pr.http_request")
    def test_get_task_invalid_response(self, mock_http):
        """Test invalid response format."""
        mock_http.return_value = {"error": "something went wrong"}

        task = post_pr.get_task("TEST-123")

        assert task is None


class TestValidateTaskData:
    """Test validate_task_data function."""

    def test_validate_valid_task(self):
        """Test validation of valid task."""
        task = {"pr_url": "https://github.com/org/repo/pull/123", "pr_number": 123, "summary": "Test PR"}

        valid, field, value = post_pr.validate_task_data(task)

        assert valid is True
        assert field is None
        assert value is None

    def test_validate_missing_pr_url(self):
        """Test validation fails when pr_url is missing."""
        task = {"pr_number": 123, "summary": "Test PR"}

        valid, field, value = post_pr.validate_task_data(task)

        assert valid is False
        assert field == "pr_url"
        assert value is None

    def test_validate_missing_pr_number(self):
        """Test validation fails when pr_number is missing."""
        task = {"pr_url": "https://github.com/org/repo/pull/123", "summary": "Test PR"}

        valid, field, value = post_pr.validate_task_data(task)

        assert valid is False
        assert field == "pr_number"

    def test_validate_invalid_pr_url_format(self):
        """Test validation fails with invalid PR URL."""
        task = {
            "pr_url": "not-a-url",
            "pr_number": 123,
        }

        valid, field, value = post_pr.validate_task_data(task)

        assert valid is False
        assert field == "pr_url"
        assert value == "not-a-url"

    def test_validate_invalid_pr_number_format(self):
        """Test validation fails with non-numeric PR number."""
        task = {
            "pr_url": "https://github.com/org/repo/pull/123",
            "pr_number": "not-a-number",
        }

        valid, field, value = post_pr.validate_task_data(task)

        assert valid is False
        assert field == "pr_number"
        assert value == "not-a-number"


class TestHttpRequest:
    """Test http_request function."""

    @patch("urllib.request.urlopen")
    def test_http_request_success(self, mock_urlopen):
        """Test successful HTTP request."""
        mock_response = MagicMock()
        mock_response.read.return_value = b'{"result": "success"}'
        mock_urlopen.return_value.__enter__.return_value = mock_response

        result = post_pr.http_request("http://test.com/api")

        assert result == {"result": "success"}

    @patch("urllib.request.urlopen")
    def test_http_request_empty_response(self, mock_urlopen):
        """Test HTTP request with empty response."""
        mock_response = MagicMock()
        mock_response.read.return_value = b""
        mock_urlopen.return_value.__enter__.return_value = mock_response

        result = post_pr.http_request("http://test.com/api")

        assert result == {}

    @patch("urllib.request.urlopen")
    def test_http_request_network_error(self, mock_urlopen):
        """Test HTTP request with network error."""
        mock_urlopen.side_effect = Exception("Network error")

        result = post_pr.http_request("http://test.com/api")

        assert result is None


class TestMainFunction:
    """Test main function."""

    @patch("post_pr.get_task")
    @patch("post_pr.execute_post_pr_workflow")
    def test_main_success(self, mock_workflow, mock_get_task):
        """Test successful main execution."""
        # Setup mocks
        mock_get_task.return_value = {
            "external_key": "TEST-123",
            "pr_url": "https://github.com/org/repo/pull/1",
            "pr_number": 1,
            "summary": "Test PR",
        }

        mock_result = MagicMock()
        mock_result.success = True
        mock_result.operations = []
        mock_workflow.return_value = mock_result

        # Test
        with patch.object(sys, "argv", ["post_pr.py", "TEST-123"]):
            with pytest.raises(SystemExit) as exc_info:
                post_pr.main()

        assert exc_info.value.code == 0

    @patch("post_pr.get_task")
    def test_main_task_not_found(self, mock_get_task):
        """Test main exits when task not found."""
        mock_get_task.return_value = None

        with patch.object(sys, "argv", ["post_pr.py", "TEST-123"]):
            with pytest.raises(SystemExit) as exc_info:
                post_pr.main()

        assert exc_info.value.code == 1

    @patch("post_pr.get_task")
    def test_main_invalid_task_data(self, mock_get_task):
        """Test main exits when task data is invalid."""
        mock_get_task.return_value = {
            "external_key": "TEST-123",
            # Missing pr_url and pr_number
        }

        with patch.object(sys, "argv", ["post_pr.py", "TEST-123"]):
            with pytest.raises(SystemExit) as exc_info:
                post_pr.main()

        assert exc_info.value.code == 1

    @patch("post_pr.get_task")
    @patch("post_pr.execute_post_pr_workflow")
    def test_main_workflow_failure(self, mock_workflow, mock_get_task):
        """Test main exits with error when workflow fails."""
        mock_get_task.return_value = {
            "external_key": "TEST-123",
            "pr_url": "https://github.com/org/repo/pull/1",
            "pr_number": 1,
            "summary": "Test PR",
        }

        mock_result = MagicMock()
        mock_result.success = False
        mock_result.operations = []
        mock_workflow.return_value = mock_result

        with patch.object(sys, "argv", ["post_pr.py", "TEST-123"]):
            with pytest.raises(SystemExit) as exc_info:
                post_pr.main()

        assert exc_info.value.code == 1

    def test_main_no_args(self):
        """Test main exits with error when no arguments provided."""
        with patch.object(sys, "argv", ["post_pr.py"]):
            with pytest.raises(SystemExit) as exc_info:
                post_pr.main()

        assert exc_info.value.code == 1
