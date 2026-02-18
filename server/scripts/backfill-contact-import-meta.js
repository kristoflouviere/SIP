const { PrismaClient } = require("@prisma/client");

async function run() {
  const prisma = new PrismaClient();

  try {
    const allRows = await prisma.contact.findMany({
      select: {
        id: true,
        source: true,
        createdAt: true,
        importedAt: true,
        sourceImportMeta: true
      }
    });

    const rows = allRows.filter(
      (row) => row.importedAt === null || row.sourceImportMeta === null
    );

    let updated = 0;

    for (const row of rows) {
      const importedAt = row.importedAt || row.createdAt || new Date();
      const source = row.source || "manual";
      const existingMeta =
        row.sourceImportMeta && typeof row.sourceImportMeta === "object"
          ? row.sourceImportMeta
          : {};

      const sourceImportMeta = {
        ...existingMeta,
        source,
        importedAt: new Date(importedAt).toISOString()
      };

      await prisma.contact.update({
        where: { id: row.id },
        data: {
          importedAt,
          sourceImportMeta
        }
      });

      updated += 1;
    }

    const remainingRows = await prisma.contact.findMany({
      select: {
        importedAt: true,
        sourceImportMeta: true
      }
    });
    const remaining = remainingRows.filter(
      (row) => row.importedAt === null || row.sourceImportMeta === null
    ).length;

    console.log(JSON.stringify({ examined: rows.length, updated, remaining }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
