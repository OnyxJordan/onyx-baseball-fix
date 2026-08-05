"""Minimal async Zendesk API client for the Discord support bridge.

Uses the Zendesk Tickets API with email/API-token basic auth:
https://developer.zendesk.com/api-reference/ticketing/tickets/tickets/
"""

import aiohttp


class ZendeskError(Exception):
    """Raised when the Zendesk API returns a non-2xx response."""

    def __init__(self, status: int, detail: str):
        self.status = status
        super().__init__(f"Zendesk API error {status}: {detail}")


class ZendeskClient:
    def __init__(self, subdomain: str, email: str, api_token: str):
        self.base_url = f"https://{subdomain}.zendesk.com/api/v2"
        self._auth = aiohttp.BasicAuth(f"{email}/token", api_token)
        self._session: aiohttp.ClientSession | None = None

    async def _request(self, method: str, path: str, json: dict | None = None) -> dict:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(auth=self._auth)
        async with self._session.request(
            method, f"{self.base_url}{path}", json=json
        ) as resp:
            if resp.status >= 400:
                raise ZendeskError(resp.status, await resp.text())
            return await resp.json()

    async def close(self) -> None:
        if self._session is not None and not self._session.closed:
            await self._session.close()

    async def create_ticket(
        self,
        subject: str,
        body: str,
        requester_name: str,
        requester_email: str,
        tags: list[str] | None = None,
    ) -> dict:
        """Create a ticket and return the ticket object (includes id, requester_id)."""
        payload = {
            "ticket": {
                "subject": subject,
                "comment": {"body": body},
                "requester": {"name": requester_name, "email": requester_email},
                "tags": tags or ["discord"],
            }
        }
        data = await self._request("POST", "/tickets.json", json=payload)
        return data["ticket"]

    async def add_comment(
        self, ticket_id: int, body: str, author_id: int | None = None, public: bool = True
    ) -> dict:
        """Append a comment to an existing ticket."""
        comment: dict = {"body": body, "public": public}
        if author_id is not None:
            comment["author_id"] = author_id
        data = await self._request(
            "PUT", f"/tickets/{ticket_id}.json", json={"ticket": {"comment": comment}}
        )
        return data["ticket"]

    async def get_ticket(self, ticket_id: int) -> dict:
        data = await self._request("GET", f"/tickets/{ticket_id}.json")
        return data["ticket"]
