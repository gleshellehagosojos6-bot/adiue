import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged,
  setPersistence, browserLocalPersistence, browserSessionPersistence, EmailAuthProvider, reauthenticateWithCredential, updatePassword, deleteUser } from 'firebase/auth';
import { initializeFirestore, connectFirestoreEmulator, doc, collection, getDoc, getDocs, setDoc, deleteDoc, onSnapshot } from 'firebase/firestore';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
window.FirebaseSDK = { initializeApp, getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged,
  setPersistence, browserLocalPersistence, browserSessionPersistence, EmailAuthProvider, reauthenticateWithCredential, updatePassword, deleteUser,
  initializeFirestore, connectFirestoreEmulator, doc, collection, getDoc, getDocs, setDoc, deleteDoc, onSnapshot,
  getFunctions, connectFunctionsEmulator, httpsCallable };
