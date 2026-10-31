# Installing ChatHand on macOS

[中文](INSTALL.md)

Get the disk image for the current ChatHand version. To compare its checksum with the value supplied for that release, run:

```sh
shasum -a 256 ~/Downloads/ChatHand*.dmg
```

If the folder contains multiple disk images, compare the line for the file you downloaded. If it is stored elsewhere, use its actual path.

Open the disk image and follow its instructions. You can install with help from ChatGPT or follow the manual steps. macOS may ask you to allow the first opening of a preview build.

After opening ChatHand, choose a connection method and follow the setup pages. For OpenAI Tunnel, create the tunnel and a restricted runtime key on the OpenAI platform. ChatGPT app availability and permissions depend on your account and workspace.

The runtime key is encrypted and stored in local files on your Mac. Do not paste it into a chat or issue.
