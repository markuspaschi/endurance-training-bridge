const { Firestore } = require('@google-cloud/firestore');

const athleteId = process.argv[2];
const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;

if (!athleteId || !/^[A-Za-z0-9._@+-]{1,128}$/.test(athleteId)) {
  console.error('Usage: GOOGLE_CLOUD_PROJECT=your-project node clear_garmin_cache.cjs <athlete-id>');
  process.exit(2);
}

if (!projectId) {
  console.error('GOOGLE_CLOUD_PROJECT is required');
  process.exit(2);
}

const db = new Firestore({ projectId });

async function clear() {
  const collections = ['garmin_activity_cache', 'garmin_activities_list_cache'];
  for (const col of collections) {
    const snap = await db.collection(col)
      .where('__name__', '>=', `${athleteId}_`)
      .where('__name__', '<', `${athleteId}_\uf8ff`)
      .get();
    console.log(`Found ${snap.size} docs in ${col}`);
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    if (snap.size) await batch.commit();
    console.log(`Deleted ${snap.size} docs from ${col}`);
  }
}
clear().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
