"""Discord -> Zendesk support bridge.

How it works:
  * Anyone who posts a message in the configured support channel gets a
    Zendesk ticket created automatically. The bot replies with the ticket
    number and opens a Discord thread for the conversation.
  * Messages posted inside that thread are appended to the same Zendesk
    ticket as comments, so support agents see the whole exchange.
  * /ticket works from any channel as an explicit alternative, and
    /status looks up the current state of a ticket by number.

Run with:  python -m support_bridge.bot   (from the repo root)
"""

import json
import logging
import os
from pathlib import Path

import discord
from discord import app_commands
from dotenv import load_dotenv

from .zendesk import ZendeskClient, ZendeskError

load_dotenv(Path(__file__).parent / ".env")

log = logging.getLogger("support_bridge")

DISCORD_TOKEN = os.environ["DISCORD_BOT_TOKEN"]
SUPPORT_CHANNEL_ID = int(os.environ.get("SUPPORT_CHANNEL_ID", "0"))
ZENDESK_SUBDOMAIN = os.environ["ZENDESK_SUBDOMAIN"]
ZENDESK_EMAIL = os.environ["ZENDESK_EMAIL"]
ZENDESK_API_TOKEN = os.environ["ZENDESK_API_TOKEN"]
# Discord does not expose user emails, so each Discord user is mapped to a
# stable synthetic requester address in Zendesk (keyed by their Discord ID).
REQUESTER_EMAIL_DOMAIN = os.environ.get("REQUESTER_EMAIL_DOMAIN", "discord.onyxodds.com")
TICKET_STORE_PATH = Path(
    os.environ.get("TICKET_STORE_PATH", Path(__file__).parent / "tickets.json")
)

SUBJECT_MAX_LEN = 80


class TicketStore:
    """Maps Discord thread IDs to Zendesk ticket/requester IDs (JSON on disk)."""

    def __init__(self, path: Path):
        self.path = path
        self._data: dict[str, dict] = {}
        if path.exists():
            self._data = json.loads(path.read_text())

    def get(self, thread_id: int) -> dict | None:
        return self._data.get(str(thread_id))

    def put(self, thread_id: int, ticket_id: int, requester_id: int) -> None:
        self._data[str(thread_id)] = {
            "ticket_id": ticket_id,
            "requester_id": requester_id,
        }
        self.path.write_text(json.dumps(self._data, indent=2))


def requester_email(user: discord.abc.User) -> str:
    return f"discord.{user.id}@{REQUESTER_EMAIL_DOMAIN}"


def make_subject(text: str) -> str:
    lines = text.strip().splitlines()
    first_line = lines[0] if lines else ""
    if len(first_line) > SUBJECT_MAX_LEN:
        first_line = first_line[: SUBJECT_MAX_LEN - 1] + "…"
    return first_line or "Discord support request"


def ticket_embed(ticket_id: int, subject: str) -> discord.Embed:
    embed = discord.Embed(
        title=f"Ticket #{ticket_id} created",
        description=subject,
        color=discord.Color.green(),
    )
    embed.set_footer(text="Our support team will get back to you here.")
    return embed


class SupportBridge(discord.Client):
    def __init__(self):
        intents = discord.Intents.default()
        intents.message_content = True  # privileged: enable in the Discord dev portal
        super().__init__(intents=intents)
        self.tree = app_commands.CommandTree(self)
        self.zendesk = ZendeskClient(ZENDESK_SUBDOMAIN, ZENDESK_EMAIL, ZENDESK_API_TOKEN)
        self.store = TicketStore(TICKET_STORE_PATH)

    async def setup_hook(self) -> None:
        await self.tree.sync()

    async def close(self) -> None:
        await self.zendesk.close()
        await super().close()

    async def create_ticket_for(
        self, user: discord.abc.User, subject: str, body: str
    ) -> dict:
        description = f"{body}\n\n---\nOpened from Discord by {user} (ID {user.id})."
        return await self.zendesk.create_ticket(
            subject=subject,
            body=description,
            requester_name=user.display_name,
            requester_email=requester_email(user),
        )

    async def on_message(self, message: discord.Message) -> None:
        if message.author.bot or not message.guild:
            return

        # Follow-up inside a ticket thread -> comment on the existing ticket.
        if isinstance(message.channel, discord.Thread):
            mapping = self.store.get(message.channel.id)
            if mapping:
                await self._sync_followup(message, mapping)
            return

        # New message in the support channel -> new ticket + thread.
        if SUPPORT_CHANNEL_ID and message.channel.id == SUPPORT_CHANNEL_ID:
            await self._open_ticket_from_message(message)

    async def _open_ticket_from_message(self, message: discord.Message) -> None:
        subject = make_subject(message.content or "Discord support request")
        try:
            ticket = await self.create_ticket_for(message.author, subject, message.content)
        except ZendeskError:
            log.exception("Failed to create Zendesk ticket")
            await message.reply(
                "Sorry, I couldn't create a ticket right now. "
                "Please try again in a few minutes."
            )
            return

        thread = await message.create_thread(
            name=f"Ticket #{ticket['id']} – {subject}"[:100]
        )
        self.store.put(thread.id, ticket["id"], ticket["requester_id"])
        await thread.send(
            content=message.author.mention, embed=ticket_embed(ticket["id"], subject)
        )
        log.info("Created ticket %s from message %s", ticket["id"], message.id)

    async def _sync_followup(self, message: discord.Message, mapping: dict) -> None:
        body = f"{message.author.display_name} (via Discord):\n\n{message.content}"
        try:
            await self.zendesk.add_comment(
                mapping["ticket_id"],
                body,
                author_id=mapping.get("requester_id"),
            )
            await message.add_reaction("📨")
        except ZendeskError:
            log.exception("Failed to sync comment to ticket %s", mapping["ticket_id"])
            await message.add_reaction("⚠️")


client = SupportBridge()


@client.tree.command(description="Open a support ticket in Zendesk")
@app_commands.describe(
    subject="Short summary of your issue",
    description="What's going on? Include as much detail as you can.",
)
async def ticket(interaction: discord.Interaction, subject: str, description: str):
    await interaction.response.defer(ephemeral=True)
    try:
        zd_ticket = await client.create_ticket_for(interaction.user, subject, description)
    except ZendeskError:
        log.exception("Failed to create Zendesk ticket via /ticket")
        await interaction.followup.send(
            "Sorry, I couldn't create a ticket right now. Please try again shortly.",
            ephemeral=True,
        )
        return
    await interaction.followup.send(
        embed=ticket_embed(zd_ticket["id"], subject), ephemeral=True
    )


@client.tree.command(description="Check the status of a support ticket")
@app_commands.describe(number="The ticket number, e.g. 123")
async def status(interaction: discord.Interaction, number: int):
    await interaction.response.defer(ephemeral=True)
    try:
        zd_ticket = await client.zendesk.get_ticket(number)
    except ZendeskError as err:
        msg = (
            f"Ticket #{number} was not found."
            if err.status == 404
            else "Sorry, I couldn't reach Zendesk right now."
        )
        await interaction.followup.send(msg, ephemeral=True)
        return
    await interaction.followup.send(
        f"Ticket **#{number}** — *{zd_ticket['subject']}* — "
        f"status: **{zd_ticket['status']}**",
        ephemeral=True,
    )


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    client.run(DISCORD_TOKEN)


if __name__ == "__main__":
    main()
