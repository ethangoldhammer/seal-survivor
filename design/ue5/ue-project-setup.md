# UE5 project repo: git + LFS

## Paste this into the PC session

> Clone `git@github.com:ethangoldhammer/seal-survivor.git` and check out branch `ue5-seal-export`
> (it is not on the default branch). Read `design/ue5/SEAL-ANIM-STATE-MACHINE.md` and this file. Install Blender
> 5.x if missing, then run `tools/ue5-seal-export.py` (headless, command below) with the output dir set to a
> `Source_Art/Seal` folder inside my UE 5.9 project. Import `SK_Seal.fbx` first, then each `A_Seal_*.fbx`
> against that skeleton, and check the seal faces the red X arrow (flip `AXIS_FORWARD` in the script if not).
> Then create the UE project repo from `ue-project.gitattributes` / `ue-project.gitignore` and add a CLAUDE.md.
> Do not edit the seal-survivor repo; send changes back as a branch.

This repo (seal-survivor) already holds the source art (`public/models/*.glb`) as plain git blobs and the
export script. Do NOT convert those to LFS: `npm run ship`, the Pages build and the Capacitor builds read
them directly, and rewriting 175 tracked glbs would bloat history (.git is already ~600 MB).

The UE project is a SEPARATE repo, where exports and `.uasset` files go through LFS.

## Mac and PC workflow

1. Mac: `git push` this repo. PC: `git clone git@github.com:ethangoldhammer/seal-survivor.git`
2. PC: install Blender, then regenerate the exports (no file transfer needed):
   `"C:\Program Files\Blender Foundation\Blender 5.0\blender.exe" -b -P tools\ue5-seal-export.py -- <ue project>\Source_Art\Seal`
3. Import into UE as in `SEAL-ANIM-STATE-MACHINE.md`.

## Creating the UE project repo (once, on the PC)

```bash
git lfs install
cd <UE project folder>
git init -b main
# copy ue-project.gitattributes -> .gitattributes and ue-project.gitignore -> .gitignore
git add . && git commit -m "UE project"
git remote add origin git@github.com:ethangoldhammer/seal-ue.git   # create a PRIVATE repo first
git push -u origin main
```

GitHub's free LFS tier is 1 GB storage and 1 GB/month bandwidth. A solo UE project outgrows that; budget for
a data pack, or use Perforce instead.
Also put a `CLAUDE.md` at that repo's root: Claude's memory is per machine and will not follow you.
