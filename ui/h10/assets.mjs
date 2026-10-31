import {uiText} from '../local-text.mjs';
/** Source files are copied unchanged. All Figma teaching imagery is design evidence only.
 * Site reference images contain generic ChatGPT UI; they do not establish route health. */
export const assets = Object.freeze({
  "appIcon": {
    "src": "./assets/AppIcon-rounded-512.png",
    "alt": "ChatHand",
    "routes": [
      "site",
      "openai"
    ],
    "provenance": "fixed-source-app-icon",
    "sourceCommit": "4199377d73ed7c76ab6a3ae81d5eb2182d41d741",
    "sha256": "344e263273b120067f3f47b8aad9f565beec46b653f005a42b080e312acc3e8c"
  },
  "people": {
    "src": "./assets/source-derived/people-356-2939-source-derived.svg",
    get "alt"(){return uiText("ui.h10.assets.peopleAlt");},
    "routes": [
      "site",
      "openai"
    ],
    "provenance": "source-derived",
    "sourceNode": "356:2939",
    "sourceNodeUrl": "https://www.figma.com/design/Yu0UtaxB3pfj4Q4HZNz66S?node-id=356-2939",
    "sourceKind": "source-derived-svg-composition",
    "sourceRouteLabel": "F1/F4",
    "sourcePath": "SOURCE-DERIVED-MAP-r4.json",
    "sha256": "820e00bb3d2e44405812a2bcc250ee44e350e4c9a9a3c28daf0561fab83e60f3",
    "width": 260,
    "height": 200,
    "format": "svg",
    "role": "illustration"
  },
  "gatekeeperDone": {
    "src": "./assets/source-derived/gatekeeperDone-356-2885-source-derived-r5.svg",
    get "alt"(){return uiText("ui.h10.assets.gatekeeperDoneAlt");},
    "routes": [
      "site",
      "openai"
    ],
    "provenance": "source-derived",
    "sourceNode": "356:2885",
    "sourceNodeUrl": "https://www.figma.com/design/Yu0UtaxB3pfj4Q4HZNz66S?node-id=356-2885",
    "sourceKind": "source-derived-svg-composition",
    "sourceRouteLabel": "F5",
    "sourcePath": "SOURCE-DERIVED-MAP-r5.json",
    "sha256": "7d6131e1226dc9b20427e3708297b68c0335bf389cdb69605d0b6575f21672fd",
    "width": 280,
    "height": 176,
    "format": "svg",
    "role": "illustration"
  },
  "gatekeeperOpen": {
    "src": "./assets/source-derived/gatekeeperOpen-356-2898-source-derived-r5.svg",
    get "alt"(){return uiText("ui.h10.assets.gatekeeperOpenAlt");},
    "routes": [
      "site",
      "openai"
    ],
    "provenance": "source-derived",
    "sourceNode": "356:2898",
    "sourceNodeUrl": "https://www.figma.com/design/Yu0UtaxB3pfj4Q4HZNz66S?node-id=356-2898",
    "sourceKind": "source-derived-svg-composition",
    "sourceRouteLabel": "F5",
    "sourcePath": "SOURCE-DERIVED-MAP-r5.json",
    "sha256": "f5cf20096056fcb29b4cc5f8735f18dae0756837196c427ff316c35c4f6ce2d7",
    "width": 280,
    "height": 176,
    "format": "svg",
    "role": "illustration"
  },
  "gatekeeperConfirm": {
    "src": "./assets/source-derived/gatekeeperConfirm-356-2919-source-derived-r5.svg",
    get "alt"(){return uiText("ui.h10.assets.gatekeeperConfirmAlt");},
    "routes": [
      "site",
      "openai"
    ],
    "provenance": "source-derived",
    "sourceNode": "356:2919",
    "sourceNodeUrl": "https://www.figma.com/design/Yu0UtaxB3pfj4Q4HZNz66S?node-id=356-2919",
    "sourceKind": "source-derived-svg-composition",
    "sourceRouteLabel": "F5",
    "sourcePath": "SOURCE-DERIVED-MAP-r5.json",
    "sha256": "e4fcf8ec275652e98de4d451e51d0c46a79628f2325bd6b1cac8accf2a9b7a3f",
    "width": 280,
    "height": 176,
    "format": "svg",
    "role": "illustration"
  },
  "assisted": {
    "src": "./assets/figma/F6/assisted-356-160-frame.png",
    get "alt"(){return uiText("ui.h10.assets.assistedAlt");},
    "routes": [
      "site",
      "openai"
    ],
    "provenance": "approved-figma-asset",
    "sourceNode": "356:160",
    "sourceNodeUrl": "https://www.figma.com/design/Yu0UtaxB3pfj4Q4HZNz66S?node-id=356-160",
    "sourceKind": "figma-node-export",
    "sourceRouteLabel": "F6/F5",
    "sourcePath": "node 356:160 export",
    "sha256": "dad0a6bfc6e3bdb8b746c32a18646f95b23a03ff1db4cc1d45eda1a7250b736d",
    "width": 388.0,
    "height": 168.0,
    "format": "png",
    "role": "illustration"
  },
  "manual": {
    "src": "./assets/figma/F6/manual-356-180-frame.png",
    get "alt"(){return uiText("ui.h10.assets.manualAlt");},
    "routes": [
      "site",
      "openai"
    ],
    "provenance": "approved-figma-asset",
    "sourceNode": "356:180",
    "sourceNodeUrl": "https://www.figma.com/design/Yu0UtaxB3pfj4Q4HZNz66S?node-id=356-180",
    "sourceKind": "figma-node-export",
    "sourceRouteLabel": "F6",
    "sourcePath": "node 356:180 export",
    "sha256": "651c9d39aa0c1aa47a0c84982251b2b2dd48d80fb649ac49c7f40616be9a7cc5",
    "width": 388.0,
    "height": 168.0,
    "format": "png",
    "role": "illustration"
  },
  "releaseSource": {
    "src": "./assets/figma/F1/releaseSource-356-1961-vector-01.svg",
    get "alt"(){return uiText("ui.h10.assets.releaseSourceAlt");},
    "routes": [
      "site",
      "openai"
    ],
    "provenance": "approved-figma-asset",
    "sourceNode": "356:1961",
    "sourceNodeUrl": "https://www.figma.com/design/Yu0UtaxB3pfj4Q4HZNz66S?node-id=356-1961",
    "sourceKind": "svg-asset",
    "sourceRouteLabel": "F1",
    "sourcePath": "node 356:1961 subtree svgAssets[0]",
    "sha256": "a22880be201b35e3f830b0cce248d24e92e5b2bc4fa6b180d4591d231616e603",
    "width": 20.0,
    "height": 20.0,
    "format": "svg",
    "role": "icon"
  },
  "releaseVerify": {
    "src": "./assets/figma/F1/releaseVerify-356-1967-vector-01.svg",
    get "alt"(){return uiText("ui.h10.assets.releaseVerifyAlt");},
    "routes": [
      "site",
      "openai"
    ],
    "provenance": "approved-figma-asset",
    "sourceNode": "356:1967",
    "sourceNodeUrl": "https://www.figma.com/design/Yu0UtaxB3pfj4Q4HZNz66S?node-id=356-1967",
    "sourceKind": "svg-asset",
    "sourceRouteLabel": "F1",
    "sourcePath": "node 356:1967 subtree svgAssets[0]",
    "sha256": "e880226c507a0fff300c3b45aa70f4e8384d5f05d1f094a96746c53df3347a4e",
    "width": 20.0,
    "height": 20.0,
    "format": "svg",
    "role": "icon"
  },
  "releasePrivacy": {
    "src": "./assets/figma/F1/releasePrivacy-356-1974-vector-01.svg",
    get "alt"(){return uiText("ui.h10.assets.releasePrivacyAlt");},
    "routes": [
      "site",
      "openai"
    ],
    "provenance": "approved-figma-asset",
    "sourceNode": "356:1974",
    "sourceNodeUrl": "https://www.figma.com/design/Yu0UtaxB3pfj4Q4HZNz66S?node-id=356-1974",
    "sourceKind": "svg-asset",
    "sourceRouteLabel": "F1",
    "sourcePath": "node 356:1974 subtree svgAssets[0]",
    "sha256": "958bb9cbf0f82df9e94242993aa2517298d9eab7266992d7e49c341340a750f6",
    "width": 20.0,
    "height": 20.0,
    "format": "svg",
    "role": "icon"
  },
  "releaseLimits": {
    "src": "./assets/figma/F1/releaseLimits-356-1981-vector-01.svg",
    get "alt"(){return uiText("ui.h10.assets.releaseLimitsAlt");},
    "routes": [
      "site",
      "openai"
    ],
    "provenance": "approved-figma-asset",
    "sourceNode": "356:1981",
    "sourceNodeUrl": "https://www.figma.com/design/Yu0UtaxB3pfj4Q4HZNz66S?node-id=356-1981",
    "sourceKind": "svg-asset",
    "sourceRouteLabel": "F1",
    "sourcePath": "node 356:1981 subtree svgAssets[0]",
    "sha256": "44d038e2616a2663b57a8323b1c45614c47e59f7e22d58df5e5c34c346fb1c18",
    "width": 20.0,
    "height": 20.0,
    "format": "svg",
    "role": "icon"
  },
  "workOpen": {
    "src": "./assets/figma/F10/workOpen-356-462-frame.png",
    get "alt"(){return uiText("ui.h10.assets.workOpenAlt");},
    "routes": [
      "site",
      "openai"
    ],
    "provenance": "approved-figma-teaching",
    "sourceNode": "356:462",
    "sourceNodeUrl": "https://www.figma.com/design/Yu0UtaxB3pfj4Q4HZNz66S?node-id=356-462",
    "sourceKind": "figma-node-export",
    "sourceRouteLabel": "F10",
    "sourcePath": "node 356:462 export",
    "sha256": "c21951d25164c2ea54d157c021c3a6dd33c9c35f00acf414bb1a44182fcc0df7",
    "width": 520.0,
    "height": 325.0,
    "format": "png",
    "role": "illustration"
  },
  "workEnter": {
    "src": "./assets/figma/F10/workEnter-356-572-frame.png",
    get "alt"(){return uiText("ui.h10.assets.workEnterAlt");},
    "routes": [
      "site",
      "openai"
    ],
    "provenance": "approved-figma-teaching",
    "sourceNode": "356:572",
    "sourceNodeUrl": "https://www.figma.com/design/Yu0UtaxB3pfj4Q4HZNz66S?node-id=356-572",
    "sourceKind": "figma-node-export",
    "sourceRouteLabel": "F10",
    "sourcePath": "node 356:572 export",
    "sha256": "23f2248e39b0d9ee22d9ca2c28fe2b66983657a6a9052dac4bf1d585832b7867",
    "width": 520.0,
    "height": 325.0,
    "format": "png",
    "role": "illustration"
  },
  "workFile": {
    "src": "./assets/figma/F10/workFileFallback-356-685-frame.png",
    get "alt"(){return uiText("ui.h10.assets.workFileAlt");},
    "routes": [
      "site",
      "openai"
    ],
    "provenance": "approved-figma-teaching",
    "sourceNode": "356:685",
    "sourceNodeUrl": "https://www.figma.com/design/Yu0UtaxB3pfj4Q4HZNz66S?node-id=356-685",
    "sourceKind": "figma-node-export",
    "sourceRouteLabel": "F10",
    "sourcePath": "node 356:685 export",
    "sha256": "51e89925cd8f998ab1df0f560533146ccb62041210c1ecf62e9837829a9593cf",
    "width": 520.0,
    "height": 325.0,
    "format": "png",
    "role": "illustration"
  },
  "browserControl": {
    "src": "./assets/figma/F15/browserControl-356-1396-vector-01.svg",
    get "alt"(){return uiText("ui.h10.assets.browserControlAlt");},
    "routes": [
      "site",
      "openai"
    ],
    "provenance": "approved-figma-asset",
    "sourceNode": "356:1396",
    "sourceNodeUrl": "https://www.figma.com/design/Yu0UtaxB3pfj4Q4HZNz66S?node-id=356-1396",
    "sourceKind": "svg-asset",
    "sourceRouteLabel": "F15",
    "sourcePath": "node 356:1396 subtree svgAssets[0]",
    "sha256": "f939840b660e347350b2a857a17eaa2cf8222f1d217d11a98ee63c7203736384",
    "width": 14.0,
    "height": 14.0,
    "format": "svg",
    "role": "icon"
  },
  "desktopControl": {
    "src": "./assets/figma/F15/desktopControl-356-1404-vector-01.svg",
    get "alt"(){return uiText("ui.h10.assets.desktopControlAlt");},
    "routes": [
      "site",
      "openai"
    ],
    "provenance": "approved-figma-asset",
    "sourceNode": "356:1404",
    "sourceNodeUrl": "https://www.figma.com/design/Yu0UtaxB3pfj4Q4HZNz66S?node-id=356-1404",
    "sourceKind": "svg-asset",
    "sourceRouteLabel": "F15",
    "sourcePath": "node 356:1404 subtree svgAssets[0]",
    "sha256": "7f64b25042c69059f168d28911ac339a3b1f3238bf7055ffaff9d95e1036538d",
    "width": 14.0,
    "height": 14.0,
    "format": "svg",
    "role": "icon"
  },
  "siteConnect": {
    "src": "./assets/source-derived/siteConnect-366-144-annotated-r5.svg",
    get "alt"(){return uiText("ui.h10.assets.siteConnectAlt");},
    "routes": [
      "site",
      "openai"
    ],
    "provenance": "source-derived",
    "sourceNode": "366:144",
    "sourceNodeUrl": "https://www.figma.com/design/Yu0UtaxB3pfj4Q4HZNz66S?node-id=366-144",
    "sourceKind": "source-derived-svg-composition",
    "sourceRouteLabel": "F12prime-reference",
    "sourcePath": "SOURCE-DERIVED-MAP-r5.json",
    "sha256": "f540b236d325ca4019890d9611d27c4bffa9d76e5c5e177530545b56a8d02433",
    "width": 524,
    "height": 368,
    "format": "svg",
    "role": "illustration",
    "presentation": {
      "kind": "source-html-layers",
      "width": 524,
      "height": 368,
      "viewport": {"x":90,"y":10,"width":344,"height":348},
      "base": {
        "src": "./assets/figma-delta-r2/F12/siteConnect-366-144-frame.png",
        "sourceNode": "366:144"
      },
      "callout": {
        "src": "./assets/figma-delta/F12/circle-connect-368-124.svg",
        "sourceNode": "368:124",
        "x": 102,
        "y": 311,
        "width": 318,
        "height": 40
      }
    }
  },
  "sitePermissions": {
    "src": "./assets/source-derived/sitePermissions-366-145-annotated.svg",
    get "alt"(){return uiText("ui.h10.assets.sitePermissionsAlt");},
    "routes": [
      "site",
      "openai"
    ],
    "provenance": "source-derived",
    "sourceNode": "366:145",
    "sourceNodeUrl": "https://www.figma.com/design/Yu0UtaxB3pfj4Q4HZNz66S?node-id=366-145",
    "sourceKind": "source-derived-svg-composition",
    "sourceRouteLabel": "F12prime-reference",
    "sourcePath": "SOURCE-DERIVED-MAP-r4.json",
    "sha256": "38f1bcdf8c074eb81a53ca18ce1ca874784eaa3c7ca1433f95c425f3ed0fc807",
    "width": 300,
    "height": 368,
    "format": "svg",
    "role": "illustration",
    "presentation": {
      "kind": "source-html-layers",
      "width": 300,
      "height": 368,
      "base": {
        "src": "./assets/figma-delta/F12/sitePermissions-366-145-frame.png",
        "sourceNode": "366:145"
      },
      "callout": {
        "src": "./assets/figma-delta/F12/circle-permissions-368-125.svg",
        "sourceNode": "368:125",
        "x": 21,
        "y": 298,
        "width": 220,
        "height": 31
      },
      "ring": {"x": 15, "y": 291, "width": 278, "height": 47}
    }
  },
  "workCredential": {
    "src": "./assets/figma-delta/F10/workCredential-example-356-799-export.png",
    get "alt"(){return uiText("ui.h10.assets.workCredentialAlt");},
    "routes": [
      "site",
      "openai"
    ],
    "provenance": "approved-figma-teaching",
    "sourceNode": "356:799",
    "sourceNodeUrl": "https://www.figma.com/design/Yu0UtaxB3pfj4Q4HZNz66S?node-id=356-799",
    "sourceKind": "masked-teaching-node-export",
    "sourcePath": "onboarding-assets-delta-r1/assets/F10/workCredential-example-356-799-export.png",
    "sha256": "5588d966e9f5db7ecb793981adc5693bc6cac61c55958fcfe3e1d804c429f582",
    "width": 520,
    "height": 325,
    "format": "png",
    "role": "illustration"
  },
  "credentialCopy": {
    "src": "./assets/figma-delta/F11/credentialCopy-example-356-916-export.png",
    get "alt"(){return uiText("ui.h10.assets.credentialCopyAlt");},
    "routes": [
      "site",
      "openai"
    ],
    "provenance": "approved-figma-teaching",
    "sourceNode": "356:916",
    "sourceNodeUrl": "https://www.figma.com/design/Yu0UtaxB3pfj4Q4HZNz66S?node-id=356-916",
    "sourceKind": "masked-teaching-node-export",
    "sourcePath": "onboarding-assets-delta-r1/assets/F11/credentialCopy-example-356-916-export.png",
    "sha256": "e27989b574b5f63e0bbd12316cc1aa39e3a391783f6e95bd7061640f6d30f0d9",
    "width": 168,
    "height": 105,
    "format": "png",
    "role": "illustration"
  }
});

export const legacyReferences = Object.freeze({openaiConnect:{src:'./assets/legacy/s5d-connect.png',get "alt"(){return uiText("ui.h10.assets.openaiConnectAlt");},routes:['openai'],provenance:'legacy-fixed-source'},openaiPermissions:{src:'./assets/legacy/s5e-tool-permissions.png',get "alt"(){return uiText("ui.h10.assets.openaiPermissionsAlt");},routes:['openai'],provenance:'legacy-fixed-source'}});

export const assetLabels = Object.freeze({
  "appIcon": "ChatHand",
  get "people"(){return uiText("ui.h10.assets.peopleLabel");},
  get "gatekeeperDone"(){return uiText("ui.h10.assets.gatekeeperDoneLabel");},
  get "gatekeeperOpen"(){return uiText("ui.h10.assets.gatekeeperOpenLabel");},
  get "gatekeeperConfirm"(){return uiText("ui.h10.assets.gatekeeperConfirmLabel");},
  get "assisted"(){return uiText("ui.h10.assets.assistedLabel");},
  get "manual"(){return uiText("ui.h10.assets.manualLabel");},
  get "releaseSource"(){return uiText("ui.h10.assets.releaseSourceLabel");},
  get "releaseVerify"(){return uiText("ui.h10.assets.releaseVerifyLabel");},
  get "releasePrivacy"(){return uiText("ui.h10.assets.releasePrivacyLabel");},
  get "releaseLimits"(){return uiText("ui.h10.assets.releaseLimitsLabel");},
  get "workOpen"(){return uiText("ui.h10.assets.workOpenLabel");},
  get "workEnter"(){return uiText("ui.h10.assets.workEnterLabel");},
  get "workFile"(){return uiText("ui.h10.assets.workFileLabel");},
  get "browserControl"(){return uiText("ui.h10.assets.browserControlLabel");},
  get "desktopControl"(){return uiText("ui.h10.assets.desktopControlLabel");},
  get "siteConnect"(){return uiText("ui.h10.assets.siteConnectLabel");},
  get "sitePermissions"(){return uiText("ui.h10.assets.sitePermissionsLabel");},
  get "workCredential"(){return uiText("ui.h10.assets.workCredentialLabel");},
  get "credentialCopy"(){return uiText("ui.h10.assets.credentialCopyLabel");}
});
