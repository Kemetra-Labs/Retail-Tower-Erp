import type { posPilot as ar } from "../ar/posPilot";
import type { MessagesOf } from "../types";

export const posPilot: MessagesOf<typeof ar> = {
  "posPilot.title": "POS pilot",
  "posPilot.sub": "Pilot POS releases and the organizations allowed to download them.",

  "posPilot.releases.panelTitle": "Releases",
  "posPilot.releases.caption": "Pilot releases",
  "posPilot.releases.note": "Only the promotion workflow withdraws a release, not this page.",
  "posPilot.releases.col.version": "Version",
  "posPilot.releases.col.state": "State",
  "posPilot.releases.col.registered": "Registered",
  "posPilot.releases.col.approvedBy": "Approved by",
  "posPilot.releases.col.sha": "SHA-256",
  "posPilot.releases.col.size": "Size",
  "posPilot.releases.col.evidence": "Evidence",
  "posPilot.releases.col.action": "Action",
  "posPilot.releases.state.registered": "Registered",
  "posPilot.releases.state.current": "Current",
  "posPilot.releases.state.withdrawn": "Withdrawn",
  "posPilot.releases.notApproved": "Not approved",
  "posPilot.releases.size": "{size} MB",
  "posPilot.releases.evidence.run": "Promotion run",
  "posPilot.releases.evidence.attestation": "Attestation",
  "posPilot.releases.activate": "Activate",
  "posPilot.releases.activateFor": "Activate version {version}",
  "posPilot.releases.empty": "No registered releases",
  "posPilot.releases.emptyHint": "The promotion workflow registers approved releases.",
  "posPilot.releases.error.failed": "Couldn't load the releases.",

  "posPilot.activate.label": "Confirm release activation",
  "posPilot.activate.prompt":
    "Activate version {version}? It becomes the current pilot release, the only one Download POS can offer allowlisted organizations. It can't be undone here: only the promotion workflow can withdraw it.",
  "posPilot.activate.promptBlocked":
    "Activate version {version}? Version {current} is current, so the activation will be refused and nothing will change, unless the promotion workflow has withdrawn it.",
  "posPilot.activate.confirm": "Confirm activation",
  "posPilot.activate.done": "Version {version} is now the current release.",
  "posPilot.activate.currentExists":
    "Another release is current. The promotion workflow must withdraw it before {version} can be activated. Nothing changed.",
  "posPilot.activate.withdrawn":
    "Version {version} is withdrawn and can't be activated. Nothing changed.",
  "posPilot.activate.notFound": "This release no longer exists. The list is being read again.",

  "posPilot.allowlist.panelTitle": "Allowlisted organizations",
  "posPilot.allowlist.caption": "Pilot allowlist",
  "posPilot.allowlist.col.tenant": "Organization",
  "posPilot.allowlist.col.added": "Added",
  "posPilot.allowlist.col.action": "Action",
  "posPilot.allowlist.unknownTenant": "Unknown organization",
  "posPilot.allowlist.empty": "No organization is allowlisted",
  "posPilot.allowlist.emptyHint": "No organization finds a POS download until it is added here.",
  "posPilot.allowlist.error.failed": "Couldn't load the allowlist.",
  "posPilot.allowlist.remove": "Remove",
  "posPilot.allowlist.removeFor": "Remove {name} from the pilot",

  "posPilot.add.label": "Add an organization",
  "posPilot.add.placeholder": "Choose an organization",
  "posPilot.add.submit": "Add to pilot",
  "posPilot.add.none": "Every organization is on the allowlist.",
  "posPilot.add.directoryFailed": "Couldn't load the organizations, so none can be added now.",
  "posPilot.add.done": "{name} was added to the pilot.",
  "posPilot.add.alreadyListed": "{name} was already on the allowlist. Nothing changed.",
  "posPilot.add.tenantNotFound":
    "This organization no longer exists. The lists are being read again.",
  "posPilot.add.loading": "Loading organizations…",

  "posPilot.remove.label": "Confirm organization removal",
  "posPilot.remove.prompt":
    "Remove {name} from the pilot? It finds no POS download until it is added again.",
  "posPilot.remove.confirm": "Confirm removal",
  "posPilot.remove.done": "{name} was removed from the pilot.",

  "posPilot.notPermitted": "You aren't permitted to do this.",
  "posPilot.rateLimited": "That didn't go through because of too many requests. Try again shortly.",
  "posPilot.failed": "Couldn't complete the action. No change is confirmed.",
  "posPilot.retry": "Try again",
};
