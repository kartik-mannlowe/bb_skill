"""Comments on tasks and tickets: @mentions are checked against the project's members before anything is posted."""
import unittest

import support  # noqa: F401  (sets the import path)

from bbclient import render, service
from bbclient.errors import BBError

MEMBERS = [{"user": "kd@x.com", "full_name": "Kartik Deshpande"}, {"user": "sk@x.com", "full_name": "Sudeep Kulkarni"},
           {"user": "a1@x.com", "full_name": "Alex Lee"}, {"user": "a2@x.com", "full_name": "Alex Lee"}]


class FakeAPI:
    site = "https://bb.example"

    def __init__(self):
        self.posted = []

    def ticket(self, identifier, name):
        return {"name": name, "project": "PROJ-1"}

    def task(self, identifier, name):
        return {"name": name, "project": "PROJ-1"}

    def project(self, identifier):
        return {"custom_identifier": identifier, "users": MEMBERS}

    def add_ticket_comment(self, name, content):
        self.posted.append(("Issue", name, content))
        return {"name": "c1", "content": content, "owner": "kd@x.com", "full_name": "Kartik Deshpande",
                "creation": "2026-10-28 11:40:00"}

    def add_task_comment(self, name, content):
        self.posted.append(("Task", name, content))
        return {"name": "c2", "content": content, "owner": "kd@x.com", "full_name": "Kartik Deshpande"}


ST = {"project": {"identifier": "BR"}, "user": "kd@x.com", "site": FakeAPI.site}


class Comments(unittest.TestCase):
    def test_mention_followed_by_punctuation_notifies_that_member(self):
        api = FakeAPI()
        out = service.add_comment(api, ST, "issue", "ISS-1", "@Kartik Deshpande, please test it in the system.")
        self.assertEqual(out["mentions"], ["kd@x.com"])
        self.assertEqual(api.posted, [("Issue", "ISS-1", "@Kartik Deshpande, please test it in the system.")])
        self.assertIn("kd@x.com", render.comment(out))

    def test_a_mention_that_reaches_nobody_posts_nothing(self):
        api = FakeAPI()
        for text in ("@Kartik Deshpande Please test", "@Nobody Here, hi", "@Alex Lee, two members share this name"):
            with self.subTest(text), self.assertRaises(BBError) as e:
                service.add_comment(api, ST, "ticket", "ISS-1", text)
            self.assertEqual(e.exception.code, "bad_input")
            self.assertNotIn("Alex Lee", e.exception.extra["valid"])
        self.assertEqual(api.posted, [])

    def test_plain_task_comment_and_refusals(self):
        api = FakeAPI()
        out = service.add_comment(api, ST, "task", "T1", "  looks good  ")
        self.assertEqual((out["mentions"], api.posted), ([], [("Task", "T1", "looks good")]))
        with self.assertRaises(BBError):
            service.add_comment(api, ST, "task", "T1", "   ")
        with self.assertRaises(BBError) as e:
            service.add_comment(api, ST, "mom", "MOM-1", "hi")
        self.assertEqual(e.exception.code, "api_unsupported")


if __name__ == "__main__":
    unittest.main()
