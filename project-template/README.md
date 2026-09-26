# Current component and data catalog

This directory supplies Harness Editor's current caption, image and animation
components and editing data. It is not an independently installable or runnable
Remotion project. Create projects through Harness Editor.

The former eight launcher/config files are preserved byte-for-byte in
`tests/fixtures/legacy-template-launcher`. Tests and manual audits that need
legacy JSX recognition use `tests/fixtures/legacyTemplateProject.ts` to combine
the current catalog with four fixed historical source files in a private
directory. This does not install or execute the old launcher.

Current component paths remain stable, including the four live files read by
`installImageRendering.ts`. External animation authoring is a separate workflow;
this cleanup does not implement importing transparent animations.
