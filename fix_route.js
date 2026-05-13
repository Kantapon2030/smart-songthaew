const https = require('https');
require('dotenv').config();
const admin = require('firebase-admin');

let sa; 
try { 
  sa = require('./firebase-service-account.json'); 
} catch(e) { 
  sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT); 
}

admin.initializeApp({ 
  credential: admin.credential.cert(sa), 
  databaseURL: process.env.FIREBASE_DATABASE_URL || 'https://smart-songthaew-50aff-default-rtdb.asia-southeast1.firebasedatabase.app' 
});
const db = admin.database();

const apiKey = process.env.GOOGLE_MAPS_API_KEY;
if(!apiKey) { 
  console.error('No API key'); 
  process.exit(1); 
}

function decodePolyline(encoded) {
  let points = [];
  let index = 0, len = encoded.length;
  let lat = 0, lng = 0;
  while (index < len) {
    let b, shift = 0, result = 0;
    do { b = encoded.charAt(index++).charCodeAt(0) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    let dlat = ((result & 1) ? ~(result >> 1) : (result >> 1)); lat += dlat;
    shift = 0; result = 0;
    do { b = encoded.charAt(index++).charCodeAt(0) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    let dlng = ((result & 1) ? ~(result >> 1) : (result >> 1)); lng += dlng;
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

const origin = '8.4325,99.9629';
const dest = '8.5780,99.8160';
const url = 'https://maps.googleapis.com/maps/api/directions/json?origin=' + origin + '&destination=' + dest + '&key=' + apiKey;

https.get(url, (res) => {
  let body = '';
  res.on('data', d => body += d);
  res.on('end', () => {
    const data = JSON.parse(body);
    if(data.routes && data.routes.length > 0) {
      const poly = data.routes[0].overview_polyline.points;
      const coords = decodePolyline(poly);
      console.log('Decoded', coords.length, 'points');
      
      db.ref('routes/route_1778506361581/coords').set(coords).then(() => {
        console.log('Firebase route updated with precise polyline!');
        process.exit(0);
      });
    } else {
      console.log('No routes found', data);
      process.exit(1);
    }
  });
}).on('error', e => console.error(e));
