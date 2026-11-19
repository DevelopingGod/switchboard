import re

from app.main import app
from app.version import VERSION


def test_the_app_reports_the_one_project_version():
    assert re.fullmatch(r"\d+\.\d+\.\d+", VERSION), VERSION  # read from the root VERSION file
    assert app.version == VERSION

